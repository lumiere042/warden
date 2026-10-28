import { pathOf, sameSite } from '../util.js';

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
      else if (tag.endsWith(':radio')) value && (await field.check()); // a radio can't be unchecked; skip falsy
      else if (tag.endsWith(':checkbox')) value ? await field.check() : await field.uncheck();
      else await field.fill(String(value));
    }

    // Requests made as a result of submitting: any non-GET, or a navigation (GET forms). Analytics beacons
    // and chat widgets also fire on click, so rank each one: 3 = hits expectEndpoint, 2 = hits the form's
    // action, 1 = same site, 0 = unrelated third party (left alone, never counted as the submission).
    const actionUrl = await formEl.evaluate((f) => new URL(f.getAttribute('action') || '', document.baseURI).href);
    const target = form.expectEndpoint || pathOf(actionUrl);
    const rank = (u) => (form.expectEndpoint && u.includes(form.expectEndpoint) ? 3 : sameEndpoint(u, actionUrl) ? 2 : sameSite(u, url) ? 1 : 0);
    const captured = [];
    const capture = (req, extra) => {
      const c = { url: req.url(), method: req.method(), rank: rank(req.url()), at: Date.now(), ...extra };
      captured.push(c);
      return c;
    };
    const isNav = (req) => req.isNavigationRequest() && req.frame() === page.mainFrame();
    const isSubmission = (req) => req.method() !== 'GET' || isNav(req);
    if (mode === 'intercept') {
      await page.route('**/*', (route) => {
        const req = route.request();
        if (!isSubmission(req)) return route.continue();
        const c = capture(req, { postData: req.postData() });
        return c.rank || isNav(req) ? route.abort() : route.continue();
      });
    } else {
      page.on('response', (res) => isSubmission(res.request()) && capture(res.request(), { status: res.status() }));
    }

    // The submission is the best-ranked request. Without expectEndpoint, a same-site request counts if no
    // request to the action follows within a second (JS forms often post somewhere other than their action).
    const want = form.expectEndpoint ? 3 : 2;
    const best = () => captured.reduce((b, c) => (c.rank > (b?.rank || 0) ? c : b), null);
    const settled = () => {
      const b = best();
      return b && (b.rank >= want || (!form.expectEndpoint && Date.now() - b.at > 1000));
    };
    const submission = () => {
      const b = best();
      return b && (!form.expectEndpoint || b.rank >= 3) ? b : null;
    };
    const notSent = async () => {
      const b = best();
      if (b && form.expectEndpoint) return `request went to ${b.url}, expected ${form.expectEndpoint}`;
      return blockedReason(formEl, consoleErrors, target, captured.filter((c) => !c.rank));
    };

    const submit = form.submitSelector
      ? formEl.locator(form.submitSelector).first()
      : formEl.locator('[type=submit], button:not([type=button]):not([type=reset])').first();
    if (await submit.count()) await submit.click({ timeout: 5000 });
    else await formEl.evaluate((f) => f.requestSubmit());

    if (mode === 'intercept') {
      await waitFor(settled, 5000);
      const req = submission();
      if (!req) return { ...base, passed: false, reason: await notSent(), ...(best() && { request: best() }) };
      const missing = missingValues(req, form.fields);
      return {
        ...base,
        passed: true,
        reason: `${req.method} ${pathOf(req.url)} sent (intercepted, not delivered)` + (missing.length ? `; values not seen in payload: ${missing.join(', ')}` : ''),
        request: { url: req.url, method: req.method },
      };
    }

    // submit mode: only the submission's own response decides the result, not a third-party 4xx.
    const success = await waitForSuccess(page, form, timeout);
    await waitFor(settled, 5000);
    const sub = submission();
    if (sub?.status >= 400) return { ...base, passed: false, reason: `server returned ${sub.status} from ${pathOf(sub.url)}` };
    if (success) return { ...base, passed: true, reason: success };
    if (!sub) return { ...base, passed: false, reason: await notSent() };
    if (!form.successSelector && !form.successText) return { ...base, passed: true, reason: `${sub.method} ${pathOf(sub.url)} returned ${sub.status}` };
    return { ...base, passed: false, reason: `no success message within ${timeout / 1000}s` };
  } catch (err) {
    return { ...base, passed: false, reason: err.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

/** Explain why no submission left the browser: invalid fields, or a JS error. Lists unrelated requests seen. */
async function blockedReason(formEl, consoleErrors, target, unrelated = []) {
  const invalid = await formEl
    .evaluate((f) => [...f.querySelectorAll(':invalid')].map((el) => `${el.name || el.id || el.tagName.toLowerCase()} (${el.validationMessage})`))
    .catch(() => []);
  if (invalid.length) return `browser validation blocked submit: ${invalid.join('; ')}`;
  const list = unrelated.slice(0, 3).map((c) => `${c.method} ${shortUrl(c.url)}`).join(', ') + (unrelated.length > 3 ? ', ...' : '');
  const saw = unrelated.length ? ` (saw ${unrelated.length} unrelated request${unrelated.length > 1 ? 's' : ''}: ${list})` : '';
  if (consoleErrors.length) return `no request to ${target} was sent${saw}; JS error: ${consoleErrors[0]}`;
  return `no request to ${target} was sent after clicking submit${saw}`;
}

/** Same origin + path, ignoring the query string (GET forms put their fields there). */
function sameEndpoint(a, b) {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + u.pathname;
  } catch {
    return url;
  }
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
