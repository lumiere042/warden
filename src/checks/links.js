import { normalizeUrl, isExcluded, sameSite, mapLimit, pathOf } from '../util.js';
import { authHeaders } from '../browser.js';

// Sites that commonly refuse bots; a 403/429/999 from these is a warning, not a broken link.
const BOT_BLOCK_STATUSES = new Set([401, 403, 429, 999]);
const MAX_REDIRECTS = 10;
const RETRY_AFTER_CAP_MS = 5000;

export default {
  name: 'links',
  title: 'Broken links',
  // The HTTP redirects the browser followed to reach each crawled page, so the redirect check needn't re-fetch it.
  async collect({ response, result }) {
    const hops = [];
    for (let req = response?.request().redirectedFrom(); req; req = req.redirectedFrom()) {
      hops.unshift({ url: req.url(), status: (await req.response())?.status() ?? null });
    }
    result.data.links = { redirects: hops };
  },
  run: ({ pages, site, config, signal }) => checkLinks(pages, site, config, signal),
};

/**
 * Check every unique link/asset found on crawled pages.
 * Internal HTML pages already loaded by the crawler reuse that status instead of re-fetching.
 * Internal links that go through redirects are warnings (external redirects are not reported).
 * At most config.linkHostConcurrency probes run against any one host; a 429 is retried once.
 */
export async function checkLinks(pages, site, config, signal) {
  const sources = new Map(); // normalized url -> { kind, pages: Set, variants: Map(url as written, minus #fragment -> Set(pages)) }
  for (const page of pages) {
    for (const link of page.links) {
      const url = normalizeUrl(link.url);
      if (!url || isExcluded(url, config.exclude)) continue;
      if (!config.checkExternalLinks && !sameSite(url, site.url)) continue;
      if (!sources.has(url)) sources.set(url, { kind: link.kind, pages: new Set(), variants: new Map() });
      const entry = sources.get(url);
      entry.pages.add(page.url);
      const variant = withoutHash(link.url);
      if (!entry.variants.has(variant)) entry.variants.set(variant, new Set());
      entry.variants.get(variant).add(page.url);
    }
  }

  const known = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const urls = [...sources.keys()];
  const request = requester(config);

  const checkOne = async (url) => {
    if (signal?.aborted) return { url, skipped: true };
    const internal = sameSite(url, site.url);
    const crawled = known.get(url);
    const r = crawled && (crawled.status || crawled.error) ? { url, status: crawled.status, error: crawled.error } : { url, ...(await probe(url, config, request, internal)) };
    if (!internal || r.error || r.status >= 400) return r;

    // Redirects are judged per URL as written, so /docs/ isn't blamed for /docs redirecting (or the reverse).
    r.redirects = [];
    for (const variant of sources.get(url).variants.keys()) {
      if (signal?.aborted) break;
      let chain;
      if (variant === url && r.hops) chain = { hops: r.hops, finalUrl: r.finalUrl };
      else if (crawled && variant === crawled.url && crawled.data?.links?.redirects) chain = { hops: crawled.data.links.redirects, finalUrl: crawled.finalUrl };
      else if (crawled && (variant === crawled.finalUrl || (variant === crawled.url && crawled.url === crawled.finalUrl))) chain = { hops: [] };
      else {
        const p = await probe(variant, config, request, true);
        chain = p.error || p.status >= 400 ? { hops: [] } : p;
      }
      if (chain.hops.length) r.redirects.push({ url: variant, hops: chain.hops, finalUrl: chain.finalUrl });
    }
    return r;
  };

  // Hosts take turns, so the workers don't all queue up behind one busy host.
  const results = new Array(urls.length);
  await mapLimit(interleaveByHost(urls), config.concurrency, async (i) => (results[i] = await checkOne(urls[i])));

  const issues = [];
  for (const r of results) {
    if (r.skipped) continue;
    const { kind, pages: from, variants } = sources.get(r.url);
    const external = !sameSite(r.url, site.url);
    const foundOn = [...from];
    if (r.error) {
      issues.push({ check: 'links', severity: 'critical', key: r.url, siteWide: true, page: foundOn[0], message: `Unreachable ${kind}: ${r.error}`, detail: { url: r.url, kind, error: r.error, foundOn } });
    } else if (r.status >= 400) {
      const blocked = external && BOT_BLOCK_STATUSES.has(r.status);
      issues.push({
        check: 'links',
        severity: blocked ? 'warning' : 'critical',
        key: r.url,
        siteWide: true,
        page: foundOn[0],
        message: blocked ? `${r.status} (site may block bots)` : `Broken ${kind} (${r.status})`,
        detail: { url: r.url, kind, status: r.status, foundOn },
      });
    }
    for (const { url, hops, finalUrl } of r.redirects || []) {
      const on = [...variants.get(url)];
      const target = finalUrl && new URL(finalUrl).origin === new URL(url).origin ? pathOf(finalUrl) : finalUrl;
      issues.push({
        check: 'links',
        severity: 'warning',
        key: `redirect:${url}`,
        siteWide: true,
        page: on[0],
        message: hops.length === 1 ? `Link redirects (${hops[0].status} → ${target})` : `Redirect chain (${hops.length} hops → ${target})`,
        detail: { url, kind, status: hops[0].status, redirects: hops, finalUrl, foundOn: on },
      });
    }
  }
  return { checked: urls.length, issues };
}

/**
 * Fetch `url`, following redirects (manually when `manual`, recording each hop) up to 10.
 * Resolves to { status, hops, finalUrl } or { error }.
 */
async function probe(url, config, request, manual) {
  const attempt = async (method) => {
    const hops = [];
    for (let current = url; ; ) {
      const res = await request(current, method, manual ? 'manual' : 'follow');
      // Don't download bodies we don't need.
      res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!manual || res.status < 300 || res.status >= 400 || !location) return { status: res.status, hops, finalUrl: manual ? current : res.url || current };
      if (hops.length >= MAX_REDIRECTS) throw Object.assign(new Error(`more than ${MAX_REDIRECTS} redirects`), { redirectLoop: true });
      hops.push({ url: current, status: res.status });
      current = new URL(location, current).href;
    }
  };
  try {
    let result = await attempt('HEAD');
    // Plenty of servers mishandle HEAD; confirm failures with GET.
    if (result.status >= 400) result = await attempt('GET');
    return result;
  } catch (err) {
    if (err.redirectLoop) return { error: err.message };
    try {
      return await attempt('GET');
    } catch (err2) {
      if (err2.redirectLoop) return { error: err2.message };
      const cause = err2.cause?.code || err2.name;
      return { error: cause === 'TimeoutError' ? `timeout after ${config.timeoutMs}ms` : cause || err2.message };
    }
  }
}

/** fetch() with at most config.linkHostConcurrency requests in flight per host, retrying a 429 once (honoring Retry-After, up to 5s). */
function requester(config) {
  const perHost = Math.max(1, config.linkHostConcurrency || 2);
  const hosts = new Map(); // host -> { active, waiting: [resolve] }
  const once = (url, method, redirect) =>
    fetch(url, {
      method,
      redirect,
      headers: { 'user-agent': config.userAgent, accept: '*/*', ...authHeaders(config, url) },
      signal: AbortSignal.timeout(config.timeoutMs),
    });

  return async (url, method, redirect) => {
    const host = new URL(url).host;
    if (!hosts.has(host)) hosts.set(host, { active: 0, waiting: [] });
    const slot = hosts.get(host);
    if (slot.active < perHost) slot.active++;
    else await new Promise((resolve) => slot.waiting.push(resolve)); // the slot is handed over on release
    try {
      const res = await once(url, method, redirect);
      if (res.status !== 429) return res;
      res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, retryAfterMs(res.headers.get('retry-after'))));
      return await once(url, method, redirect);
    } finally {
      const next = slot.waiting.shift();
      if (next) next();
      else slot.active--;
    }
  };
}

/** Retry-After as seconds or an HTTP date, capped at 5s; 1s when missing or unreadable. */
export function retryAfterMs(header) {
  const value = String(header ?? '').trim();
  let ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (!value || Number.isNaN(ms)) ms = 1000;
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
}

/** Indexes of `urls`, reordered so hosts take turns (a1, b1, a2, b2, a3, ...). */
function interleaveByHost(urls) {
  const groups = new Map();
  urls.forEach((url, i) => {
    const host = new URL(url).host;
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(i);
  });
  const lists = [...groups.values()];
  const order = [];
  for (let n = 0; order.length < urls.length; n++) for (const list of lists) if (n < list.length) order.push(list[n]);
  return order;
}

function withoutHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}
