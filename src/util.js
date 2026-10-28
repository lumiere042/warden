/** Drop the #fragment and trailing slash so the same page isn't crawled twice. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    let href = u.href;
    if (u.pathname !== '/' && href.endsWith('/') && !u.search) href = href.slice(0, -1);
    return href;
  } catch {
    return null;
  }
}

/** Same host, treating www.example.com and example.com as one site. */
export function sameSite(a, b) {
  try {
    const host = (u) => new URL(u).hostname.replace(/^www\./, '');
    return host(a) === host(b);
  } catch {
    return false;
  }
}

export function isExcluded(url, patterns = []) {
  return patterns.some((p) => url.includes(p));
}

/** Run async fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
