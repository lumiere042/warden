import { normalizeUrl, isExcluded, sameSite, pathOf } from './util.js';

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|docx?|xlsx?|pptx?)$/i;

/**
 * Crawl a site with Playwright. Starts at the site URL plus anything in sitemap.xml,
 * then follows same-site links breadth-first up to maxPages.
 * Each page is loaded in a fresh browser context so timings reflect a first visit.
 */
export async function crawlSite(browser, site, config, log = () => {}) {
  const start = normalizeUrl(site.url);
  const queue = [start];
  const seen = new Set(queue);
  const pages = [];

  for (const url of await readSitemap(start, config)) {
    if (!seen.has(url) && sameSite(url, start) && !isExcluded(url, config.exclude)) {
      seen.add(url);
      queue.push(url);
    }
  }

  while (queue.length && pages.length < site.maxPages) {
    const url = queue.shift();
    log(`  crawl ${pages.length + 1}/${Math.min(site.maxPages, pages.length + queue.length + 1)} ${url}`);
    const page = await visitPage(browser, url, config, formSelectorsFor(url, site));
    pages.push(page);

    if (!page.isHtml || !sameSite(page.finalUrl || url, start)) continue;
    for (const link of page.links) {
      if (link.kind !== 'a') continue;
      const next = normalizeUrl(link.url);
      if (!next || seen.has(next) || !sameSite(next, start)) continue;
      if (isExcluded(next, config.exclude) || NON_HTML_EXT.test(new URL(next).pathname)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return pages;
}

/** Selectors of the forms configured for testing on this page, so the crawl can tell tested from untested forms. */
function formSelectorsFor(url, site) {
  const path = pathOf(url);
  return (site.forms || []).filter((f) => pathOf(new URL(f.page || '/', site.url + '/').href) === path).map((f) => f.selector);
}

async function visitPage(browser, url, config, formSelectors = []) {
  const context = await browser.newContext({ userAgent: config.userAgent });
  const page = await context.newPage();
  const consoleErrors = [];
  let transferBytes = 0;
  let requestCount = 0;
  const sizeJobs = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err.message || err).slice(0, 300)));
  page.on('requestfinished', (req) => {
    requestCount++;
    sizeJobs.push(
      req
        .sizes()
        .then((s) => (transferBytes += s.responseBodySize + s.responseHeadersSize))
        .catch(() => {})
    );
  });

  const result = { url, finalUrl: url, status: null, error: null, isHtml: false, links: [], forms: [], meta: null, perf: null, consoleErrors };
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    result.status = response ? response.status() : null;
    result.finalUrl = page.url();
    const contentType = (response && response.headers()['content-type']) || '';
    result.isHtml = contentType.includes('html');

    if (result.isHtml) {
      // Give late requests (lazy images, analytics) a moment, but don't wait forever.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      result.perf = await collectPerf(page);
      Object.assign(result, await collectDom(page, formSelectors));
    }
  } catch (err) {
    result.error = err.message.split('\n')[0];
  }

  await Promise.all(sizeJobs);
  if (result.perf) {
    result.perf.transferKb = Math.round(transferBytes / 1024);
    result.perf.requests = requestCount;
  }
  await context.close();
  return result;
}

async function collectPerf(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const nav = performance.getEntriesByType('navigation')[0];
        let lcp = null;
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) lcp = e.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
        setTimeout(() => {
          resolve({
            ttfbMs: nav ? Math.round(nav.responseStart - nav.startTime) : null,
            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
            loadMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
            lcpMs: lcp == null ? null : Math.round(lcp),
          });
        }, 200);
      })
  );
}

async function collectDom(page, formSelectors) {
  return page.evaluate((formSelectors) => {
    const attr = (sel, name) => document.querySelector(sel)?.getAttribute(name) ?? null;
    const links = [];
    const add = (kind, value) => {
      if (!value) return;
      try {
        links.push({ kind, url: new URL(value, document.baseURI).href });
      } catch {}
    };
    document.querySelectorAll('a[href]').forEach((el) => add('a', el.getAttribute('href')));
    document.querySelectorAll('img[src]').forEach((el) => add('img', el.getAttribute('src')));
    document.querySelectorAll('script[src]').forEach((el) => add('script', el.getAttribute('src')));
    document
      .querySelectorAll('link[href][rel~="stylesheet"], link[href][rel~="icon"], link[href][rel="canonical"]')
      .forEach((el) => add('link', el.getAttribute('href')));

    const forms = [...document.querySelectorAll('form')].map((f, i) => ({
      index: i,
      id: f.id || null,
      action: f.getAttribute('action') ? new URL(f.getAttribute('action'), document.baseURI).href : document.location.href,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fieldCount: f.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea, select').length,
      tested: formSelectors.some((sel) => {
        try {
          return f.matches(sel);
        } catch {
          return false;
        }
      }),
    }));

    return {
      links,
      forms,
      meta: {
        title: document.title?.trim() || null,
        description: attr('meta[name="description"]', 'content'),
        canonical: attr('link[rel="canonical"]', 'href'),
        viewport: attr('meta[name="viewport"]', 'content'),
        robots: attr('meta[name="robots"]', 'content'),
        lang: document.documentElement.getAttribute('lang'),
        h1Count: document.querySelectorAll('h1').length,
        ogTitle: attr('meta[property="og:title"]', 'content'),
        ogDescription: attr('meta[property="og:description"]', 'content'),
        ogImage: attr('meta[property="og:image"]', 'content'),
      },
    };
  }, formSelectors);
}

/** Read sitemap.xml (and one level of nested sitemap indexes). Missing sitemap is not an error. */
async function readSitemap(siteUrl, config) {
  const urls = [];
  const fetchLocs = async (url) => {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': config.userAgent },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    } catch {
      return [];
    }
  };
  for (const loc of await fetchLocs(new URL('/sitemap.xml', siteUrl).href)) {
    if (/\.xml(\?|$)/i.test(loc)) urls.push(...(await fetchLocs(loc)));
    else urls.push(loc);
  }
  return urls.map(normalizeUrl).filter(Boolean);
}
