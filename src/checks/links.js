import { normalizeUrl, isExcluded, sameSite, mapLimit } from '../util.js';

// Sites that commonly refuse bots; a 403/429/999 from these is a warning, not a broken link.
const BOT_BLOCK_STATUSES = new Set([401, 403, 429, 999]);

/**
 * Check every unique link/asset found on crawled pages.
 * Internal HTML pages already loaded by the crawler reuse that status instead of re-fetching.
 */
export async function checkLinks(pages, site, config) {
  const sources = new Map(); // url -> Set(page urls that reference it)
  for (const page of pages) {
    for (const link of page.links) {
      const url = normalizeUrl(link.url);
      if (!url || isExcluded(url, config.exclude)) continue;
      if (!config.checkExternalLinks && !sameSite(url, site.url)) continue;
      if (!sources.has(url)) sources.set(url, { kind: link.kind, pages: new Set() });
      sources.get(url).pages.add(page.url);
    }
  }

  const known = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const urls = [...sources.keys()];

  const results = await mapLimit(urls, config.concurrency, async (url) => {
    const crawled = known.get(url);
    if (crawled && (crawled.status || crawled.error)) {
      return { url, status: crawled.status, error: crawled.error };
    }
    return { url, ...(await probe(url, config)) };
  });

  const issues = [];
  for (const r of results) {
    const { kind, pages: from } = sources.get(r.url);
    const external = !sameSite(r.url, site.url);
    const foundOn = [...from];
    if (r.error) {
      issues.push({ check: 'links', severity: 'critical', key: r.url, page: foundOn[0], message: `Unreachable ${kind}: ${r.error}`, detail: { url: r.url, kind, error: r.error, foundOn } });
    } else if (r.status >= 400) {
      const blocked = external && BOT_BLOCK_STATUSES.has(r.status);
      issues.push({
        check: 'links',
        severity: blocked ? 'warning' : 'critical',
        key: r.url,
        page: foundOn[0],
        message: blocked ? `${r.status} (site may block bots)` : `Broken ${kind} (${r.status})`,
        detail: { url: r.url, kind, status: r.status, foundOn },
      });
    }
  }
  return { checked: urls.length, issues };
}

async function probe(url, config) {
  const attempt = async (method) => {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': config.userAgent, accept: '*/*' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    // Don't download bodies we don't need.
    res.body?.cancel().catch(() => {});
    return res.status;
  };
  try {
    let status = await attempt('HEAD');
    // Plenty of servers mishandle HEAD; confirm failures with GET.
    if (status >= 400) status = await attempt('GET');
    return { status };
  } catch (err) {
    try {
      return { status: await attempt('GET') };
    } catch (err2) {
      const cause = err2.cause?.code || err2.name;
      return { error: cause === 'TimeoutError' ? `timeout after ${config.timeoutMs}ms` : cause || err2.message };
    }
  }
}
