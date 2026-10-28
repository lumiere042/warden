import { pathOf } from '../util.js';

/**
 * Test the forms listed in config, and list forms the crawl found that aren't configured.
 *
 * mode "intercept" (default): fill + submit, but catch the outgoing request and abort it,
 *   so nothing reaches the site's inbox. Passes if the browser actually sends the request.
 * mode "submit": really submit, and pass if successSelector / successText shows up.
 */
export async function checkForms(browser, pages, site, config) {
  const issues = [];
  const results = [];

  for (const form of site.forms || []) {
    const url = new URL(form.page || '/', site.url + '/').href;
    const result = await testForm(browser, url, form, config);
    results.push(result);
    if (!result.passed) {
      issues.push({
        check: 'forms',
        severity: 'critical',
        key: `${form.page}|${form.selector}`,
        page: url,
        message: `Form ${form.selector} did not submit: ${result.reason}`,
        detail: result,
      });
    }
  }

  // Forms found on the site but not under test. Footer/newsletter forms repeat on every page,
  // so de-duplicate by action + method + field count.
  const untested = new Map();
  for (const page of pages) {
    for (const f of page.forms) {
      if (f.tested || f.fieldCount === 0) continue;
      const sig = `${f.method} ${f.action} ${f.fieldCount}`;
      if (!untested.has(sig)) untested.set(sig, { ...f, page: page.url, alsoOn: 0 });
      else untested.get(sig).alsoOn++;
    }
  }

  return { checked: results.length, results, untested: [...untested.values()], issues };
}

async function testForm(browser, url, form, config) {
  const mode = form.mode || 'intercept';
  const timeout = form.timeoutMs || 15000;
  const context = await browser.newContext({ userAgent: config.userAgent });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err.message || err).slice(0, 300)));
  const base = { page: url, selector: form.selector, mode };

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const formEl = page.locator(form.selector).first();
    if (!(await formEl.count())) return { ...base, passed: false, reason: `selector ${form.selector} not found on page` };

    for (const [selector, value] of Object.entries(form.fields || {})) {
      const field = formEl.locator(selector).first();
      if (!(await field.count())) return { ...base, passed: false, reason: `field ${selector} not found` };
      const tag = await field.evaluate((el) => `${el.tagName.toLowerCase()}:${el.type || ''}`);
      if (tag.startsWith('select')) await field.selectOption(String(value));
      else if (/:(checkbox|radio)$/.test(tag)) value ? await field.check() : await field.uncheck();
      else await field.fill(String(value));
    }

    // Requests made as a result of submitting: any non-GET, or a navigation (GET forms).
    const captured = [];
    const isSubmission = (req) => req.method() !== 'GET' || (req.isNavigationRequest() && req.frame() === page.mainFrame());
    if (mode === 'intercept') {
      await page.route('**/*', (route) => {
        const req = route.request();
        if (isSubmission(req)) {
          captured.push({ url: req.url(), method: req.method(), postData: req.postData() });
          return route.abort();
        }
        return route.continue();
      });
    } else {
      page.on('response', (res) => {
        const req = res.request();
        if (isSubmission(req)) captured.push({ url: req.url(), method: req.method(), status: res.status() });
      });
    }

    const submit = form.submitSelector
      ? formEl.locator(form.submitSelector).first()
      : formEl.locator('[type=submit], button:not([type=button]):not([type=reset])').first();
    if (await submit.count()) await submit.click({ timeout: 5000 });
    else await formEl.evaluate((f) => f.requestSubmit());

    if (mode === 'intercept') {
      const sent = await waitFor(() => captured.length > 0, 5000);
      if (!sent) return { ...base, passed: false, reason: await blockedReason(formEl, consoleErrors) };
      const req = captured[0];
      if (form.expectEndpoint && !req.url.includes(form.expectEndpoint)) {
        return { ...base, passed: false, reason: `request went to ${req.url}, expected ${form.expectEndpoint}`, request: req };
      }
      const missing = missingValues(req, form.fields);
      return {
        ...base,
        passed: true,
        reason: `${req.method} ${pathOf(req.url)} sent (intercepted, not delivered)` + (missing.length ? `; values not seen in payload: ${missing.join(', ')}` : ''),
        request: { url: req.url, method: req.method },
      };
    }

    // submit mode
    const success = await waitForSuccess(page, form, timeout);
    const failedResponse = captured.find((c) => c.status >= 400);
    if (failedResponse) return { ...base, passed: false, reason: `server returned ${failedResponse.status} from ${pathOf(failedResponse.url)}` };
    if (success) return { ...base, passed: true, reason: success };
    if (!form.successSelector && !form.successText && captured.length) {
      return { ...base, passed: true, reason: `${captured[0].method} ${pathOf(captured[0].url)} returned ${captured[0].status}` };
    }
    if (!captured.length) return { ...base, passed: false, reason: await blockedReason(formEl, consoleErrors) };
    return { ...base, passed: false, reason: `no success message within ${timeout / 1000}s` };
  } catch (err) {
    return { ...base, passed: false, reason: err.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

/** Explain why no request left the browser: invalid fields, or a JS error. */
async function blockedReason(formEl, consoleErrors) {
  const invalid = await formEl
    .evaluate((f) => [...f.querySelectorAll(':invalid')].map((el) => `${el.name || el.id || el.tagName.toLowerCase()} (${el.validationMessage})`))
    .catch(() => []);
  if (invalid.length) return `browser validation blocked submit: ${invalid.join('; ')}`;
  if (consoleErrors.length) return `no request sent; JS error: ${consoleErrors[0]}`;
  return 'no request was sent after clicking submit';
}

async function waitForSuccess(page, form, timeout) {
  const waits = [];
  if (form.successSelector) waits.push(page.locator(form.successSelector).first().waitFor({ state: 'visible', timeout }).then(() => `success element ${form.successSelector} shown`));
  if (form.successText) waits.push(page.getByText(form.successText).first().waitFor({ state: 'visible', timeout }).then(() => `success text "${form.successText}" shown`));
  if (!waits.length) {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return null;
  }
  return Promise.any(waits).catch(() => null);
}

function missingValues(req, fields = {}) {
  const haystack = [req.url, req.postData || ''].map((s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  }).join('\n');
  return Object.entries(fields)
    .filter(([, v]) => typeof v === 'string' && v && !haystack.includes(v))
    .map(([k]) => k);
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}
