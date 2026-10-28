import { normalizeUrl } from '../util.js';

/**
 * Problems with the crawled pages themselves:
 * - the start page is down or returns an error (critical, the whole site is affected)
 * - crawled pages that fail but nothing links to (e.g. only listed in sitemap.xml); linked ones
 *   are already reported by the links check
 * - JavaScript errors, grouped by message across pages
 */
export default {
  name: 'pages',
  title: 'Pages',
  run: async ({ pages }) => checkPages(pages),
};

const failed = (p) => Boolean(p.error) || p.status >= 400;

export function checkPages(pages) {
  const issues = [];
  const startPage = pages.find((p) => p.source === 'start') || pages[0];

  if (startPage && failed(startPage)) {
    issues.push({
      check: 'pages',
      severity: 'critical',
      key: 'site-down',
      siteWide: true,
      page: startPage.url,
      message: startPage.error ? `Site unreachable: ${startPage.error}` : `Home page returns ${startPage.status}`,
      detail: { url: startPage.url, status: startPage.status, error: startPage.error },
    });
  }

  const linked = new Set(pages.flatMap((p) => p.links.map((l) => normalizeUrl(l.url))));
  for (const p of pages) {
    if (p === startPage || !failed(p) || linked.has(normalizeUrl(p.url))) continue;
    const problem = p.error ? `is unreachable: ${p.error}` : `returns ${p.status}`;
    issues.push({
      check: 'pages',
      severity: p.error || p.status >= 500 ? 'critical' : 'warning',
      key: 'broken',
      page: p.url,
      message: p.source === 'sitemap' ? `Listed in sitemap.xml but ${problem}` : `Page ${problem}`,
      detail: { url: p.url, status: p.status, error: p.error, source: p.source },
    });
  }

  // "Failed to load resource" is the browser echoing a broken link/asset: the links check covers those.
  const errors = new Map(); // normalized message -> { message, pages }
  for (const p of pages) {
    for (const msg of p.consoleErrors || []) {
      if (/^Failed to load resource/i.test(msg)) continue;
      const key = normalizeError(msg);
      if (!key) continue;
      if (!errors.has(key)) errors.set(key, { message: msg.trim().slice(0, 200), pages: [] });
      const group = errors.get(key);
      if (!group.pages.includes(p.url)) group.pages.push(p.url);
    }
  }
  for (const [key, { message, pages: on }] of errors) {
    issues.push({
      check: 'pages',
      severity: 'warning',
      key: `js-error:${key}`,
      siteWide: true,
      page: on[0],
      message: `JavaScript error on ${on.length} page${on.length === 1 ? '' : 's'}: ${message}`,
      detail: { error: message, pages: on },
    });
  }

  return { checked: pages.length, issues };
}

/** Same error, different page: drop query strings (cache busters) and line:column numbers. */
export function normalizeError(msg) {
  return msg
    .replace(/\?[^\s)'"]*/g, '')
    .replace(/:\d+(:\d+)?(?=[\s)'"]|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
