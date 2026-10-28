import zlib from 'node:zlib';
import { normalizeUrl, isExcluded, sameSite, pathOf, throwIfAborted } from './util.js';
import { contextOptions, newContext, authHeaders } from './browser.js';
import { CHECKS, isEnabled } from './checks/index.js';

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|docx?|xlsx?|pptx?)$/i;
const SITEMAP_MAX_URLS = 5000;
const SITEMAP_MAX_DEPTH = 3;

/**
 * Crawl a site with Playwright, up to site.maxPages pages, `pageConcurrency` at a time.
 * The start page goes first, then links found on pages and sitemap URLs take turns, so
 * a big sitemap can't use up the whole page budget before any link is followed.
 * Each page is loaded in a fresh browser context so timings reflect a first visit.
 * Returned pages are in the order they were queued; each has `source`: start | link | sitemap.
 * `outDir` (the reports folder) is passed on to the checks' collect().
 */
export async function crawlSite(browser, site, config, log = () => {}, signal, { outDir } = {}) {
  contextOptions(config); // fail fast on a bad device name
  const start = normalizeUrl(site.url);
  const seen = new Set([start]);
  const queues = { link: [], sitemap: [] };
  const crawlable = (url) => url && !seen.has(url) && sameSite(url, start) && !isExcluded(url, config.exclude) && !NON_HTML_EXT.test(new URL(url).pathname);
  const enqueue = (url, source) => {
    if (!crawlable(url)) return;
    seen.add(url);
    queues[source].push({ url, source });
  };

  let sitemapDone = false;
  const sitemap = readSitemaps(start, config).then((urls) => {
    urls.forEach((u) => enqueue(u, 'sitemap'));
    sitemapDone = true;
  });

  let last = 'sitemap';
  const take = () => {
    const order = last === 'link' ? ['sitemap', 'link'] : ['link', 'sitemap'];
    const source = order.find((s) => queues[s].length);
    if (!source) return null;
    last = source;
    return queues[source].shift();
  };

  const limit = Math.max(1, config.pageConcurrency || 1);
  const pending = new Map(); // index -> promise
  const done = []; // index -> page result, until processed in order
  const pages = [];
  let dispatched = 0;
  let first = { url: start, source: 'start' };

  // Rejects as soon as the signal fires, so a cancel doesn't wait for slow pages.
  const aborted = new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('Scan cancelled')), { once: true }));
  aborted.catch(() => {});

  for (;;) {
    throwIfAborted(signal);
    // The start page loads alone: its links are the most important ones to queue.
    while (pending.size < limit && dispatched < site.maxPages && !(dispatched === 1 && !pages.length)) {
      if (!first && !sitemapDone) await sitemap;
      const item = first || take();
      first = null;
      if (!item) break;
      const index = dispatched++;
      const queued = queues.link.length + queues.sitemap.length;
      log(`  crawl ${index + 1}/${Math.min(site.maxPages, dispatched + queued)} ${item.url}`);
      const job = visitPage(browser, item.url, config, site, outDir).then((page) => {
        page.source = item.source;
        done[index] = page;
        pending.delete(index);
      });
      pending.set(index, job);
    }
    if (!pending.size) break;
    await Promise.race([...pending.values(), aborted]);

    // Handle finished pages in queue order, so link discovery (and the result order) doesn't depend on timing.
    while (done[pages.length]) {
      const page = done[pages.length];
      done[pages.length] = null;
      pages.push(page);
      // Error pages (404 templates etc.) often link to more junk; don't crawl what they point to.
      if (!page.isHtml || page.error || page.status >= 400 || !sameSite(page.finalUrl || page.url, start)) continue;
      for (const link of page.links) if (link.kind === 'a') enqueue(normalizeUrl(link.url), 'link');
    }
  }
  return pages;
}

/** Selectors of the forms configured for testing on this page, so the crawl can tell tested from untested forms. */
function formSelectorsFor(url, site) {
  const path = pathOf(url);
  return (site.forms || []).filter((f) => pathOf(new URL(f.page || '/', site.url + '/').href) === path).map((f) => f.selector);
}

/** Load one page and collect everything the checks need. Never throws: failures end up in result.error. */
async function visitPage(browser, url, config, site, outDir) {
  const consoleErrors = [];
  const sizeJobs = [];
  let transferBytes = 0;
  let requestCount = 0;
  let context;

  const result = { url, finalUrl: url, status: null, error: null, isHtml: false, links: [], forms: [], meta: null, perf: null, consoleErrors, data: {} };
  try {
    context = await newContext(browser, config);
    const page = await context.newPage();
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

    const response = await page.goto(url, { waitUntil: 'load', timeout: config.pageTimeoutMs || 30000 });
    result.status = response ? response.status() : null;
    result.finalUrl = page.url();
    const contentType = (response && response.headers()['content-type']) || '';
    result.isHtml = contentType.includes('html');

    if (result.isHtml) {
      // Give late requests (lazy images, analytics) a moment, but don't wait forever.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      result.perf = await collectPerf(page);
      Object.assign(result, await collectDom(page, formSelectorsFor(url, site)));
      for (const check of CHECKS) {
        if (!check.collect || !isEnabled(check, config)) continue;
        try {
          await check.collect({ page, response, result, site, config, outDir });
        } catch (err) {
          result.data[check.name] = { error: err.message.split('\n')[0] };
        }
      }
    }
  } catch (err) {
    result.error = err.message.split('\n')[0];
  }

  await Promise.all(sizeJobs);
  if (result.perf) {
    result.perf.transferKb = Math.round(transferBytes / 1024);
    result.perf.requests = requestCount;
  }
  await context?.close().catch(() => {});
  return result;
}

async function collectPerf(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const nav = performance.getEntriesByType('navigation')[0];
        let lcp = null;
        let cls = 0;
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) lcp = e.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
        try {
          // Shifts right after a click or key press are expected, so they don't count.
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {}
        setTimeout(() => {
          resolve({
            ttfbMs: nav ? Math.round(nav.responseStart - nav.startTime) : null,
            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
            loadMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
            lcpMs: lcp == null ? null : Math.round(lcp),
            cls: Math.round(cls * 1000) / 1000,
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

/**
 * Page URLs from /sitemap.xml plus any `Sitemap:` lines in /robots.txt. Follows nested
 * sitemap indexes up to 3 levels, reads .xml.gz, and stops at 5000 URLs.
 * A missing sitemap is not an error.
 */
async function readSitemaps(siteUrl, config) {
  const fetchText = async (url) => {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': config.userAgent, ...authHeaders(config, url) },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!res.ok) return '';
      const buf = Buffer.from(await res.arrayBuffer());
      // .xml.gz files usually arrive still compressed (no Content-Encoding header).
      return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
    } catch {
      return '';
    }
  };

  const robots = await fetchText(new URL('/robots.txt', siteUrl).href);
  const roots = [new URL('/sitemap.xml', siteUrl).href];
  for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
    try {
      roots.push(new URL(m[1], siteUrl).href);
    } catch {}
  }

  const urls = new Set();
  const visited = new Set();
  const walk = async (url, depth) => {
    if (visited.has(url) || depth > SITEMAP_MAX_DEPTH || urls.size >= SITEMAP_MAX_URLS) return;
    visited.add(url);
    const xml = await fetchText(url);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    for (const loc of locs) {
      if (isIndex || /\.xml(\.gz)?(\?|$)/i.test(loc)) await walk(loc, depth + 1);
      else if (urls.size < SITEMAP_MAX_URLS) urls.add(loc);
    }
  };
  for (const root of roots) await walk(root, 1);
  return [...urls].map(normalizeUrl).filter(Boolean);
}
