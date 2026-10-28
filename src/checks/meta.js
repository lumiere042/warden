import { normalizeUrl, sameSite, pathOf } from '../util.js';
import { authHeaders } from '../browser.js';

const HREFLANG = /^([a-z]{2,3}(-[A-Za-z]{2,4})?|x-default)$/i;

export default {
  name: 'meta',
  title: 'Meta & SEO',
  // Extra DOM data for the checks below: resolved canonical, images without alt, hreflang alternates, icon links.
  async collect({ page, result }) {
    result.data.meta = await page.evaluate(() => {
      const noAlt = [...document.querySelectorAll('img:not([alt])')];
      return {
        canonicalHref: document.querySelector('link[rel="canonical"]')?.href || null,
        imgNoAlt: { count: noAlt.length, srcs: noAlt.slice(0, 3).map((img) => img.src || img.getAttribute('src') || '') },
        hreflang: [...document.querySelectorAll('link[rel~="alternate"][hreflang]')].map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href })),
        hasIcon: Boolean(document.querySelector('link[rel~="icon"][href]')),
      };
    });
  },
  run: async ({ pages, site, config }) => {
    const result = checkMeta(pages, site);
    const favicon = await checkFavicon(pages, site, config);
    if (favicon) result.issues.push(favicon);
    return result;
  },
};

/** SEO / meta-tag checks per page, plus site-wide duplicate detection. */
export function checkMeta(pages, site = null) {
  const issues = [];
  const htmlPages = pages.filter((p) => p.isHtml && p.meta && p.status && p.status < 400);
  const add = (page, severity, key, message, detail) => issues.push({ check: 'meta', severity, key, page: page.url, message, ...(detail ? { detail } : {}) });
  const crawled = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const siteUrl = site?.url || pages[0]?.url;

  for (const page of htmlPages) {
    const m = page.meta;
    const data = page.data?.meta || {};
    if (!m.title) add(page, 'critical', 'title-missing', 'Missing <title>');
    else if (m.title.length < 10 || m.title.length > 60) add(page, 'warning', 'title-length', `Title is ${m.title.length} chars (aim for 10–60)`);

    if (!m.description) add(page, 'warning', 'description-missing', 'Missing meta description');
    else if (m.description.length < 50 || m.description.length > 160)
      add(page, 'warning', 'description-length', `Meta description is ${m.description.length} chars (aim for 50–160)`);

    if (!m.viewport) add(page, 'warning', 'viewport', 'Missing viewport meta tag (page will not scale on mobile)');
    if (!m.lang) add(page, 'warning', 'lang', 'Missing <html lang> attribute');
    if (!m.canonical) add(page, 'warning', 'canonical', 'Missing canonical link');
    else {
      const problem = canonicalProblem(page, data.canonicalHref || resolve(m.canonical, page.finalUrl || page.url), crawled, siteUrl);
      if (problem) add(page, ...problem);
    }
    if (m.h1Count === 0) add(page, 'warning', 'h1-missing', 'No <h1> on page');
    if (m.h1Count > 1) add(page, 'warning', 'h1-multiple', `${m.h1Count} <h1> tags on page (use one)`);

    const missingOg = [['og:title', m.ogTitle], ['og:description', m.ogDescription], ['og:image', m.ogImage]]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missingOg.length) add(page, 'warning', 'open-graph', `Missing ${missingOg.join(', ')} (link previews on social media)`);

    if (m.robots && /noindex/i.test(m.robots)) add(page, 'critical', 'noindex', `Page is marked noindex ("${m.robots}") — search engines will drop it`);

    // alt="" is fine (a decorative image); no alt attribute at all is what search engines and screen readers trip on.
    const noAlt = data.imgNoAlt;
    if (noAlt?.count) {
      const srcs = noAlt.srcs.map((src) => shortSrc(src, page));
      add(page, 'warning', 'img-alt', `${noAlt.count} image${noAlt.count === 1 ? '' : 's'} without an alt attribute: ${srcs.join(', ')}${noAlt.count > srcs.length ? ', …' : ''}`, {
        count: noAlt.count,
        srcs: noAlt.srcs,
      });
    }

    const alternates = data.hreflang || [];
    if (alternates.length) {
      const invalid = [...new Set(alternates.map((a) => a.lang).filter((lang) => !HREFLANG.test(lang || '')))];
      if (invalid.length) add(page, 'warning', 'hreflang-invalid', `Invalid hreflang code${invalid.length === 1 ? '' : 's'}: ${invalid.map((l) => `"${l}"`).join(', ')}`, { invalid });
      const self = [page.url, page.finalUrl].map(normalizeUrl);
      if (!alternates.some((a) => self.includes(normalizeUrl(a.href)))) add(page, 'warning', 'hreflang-self', 'hreflang alternates don\'t include this page itself', { alternates });
    }
  }

  for (const [field, label] of [['title', 'title'], ['description', 'meta description']]) {
    const groups = new Map();
    for (const page of htmlPages) {
      const v = page.meta[field];
      if (!v) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(page.url);
    }
    for (const [value, urls] of groups) {
      if (urls.length < 2) continue;
      issues.push({
        check: 'meta',
        severity: 'warning',
        key: `duplicate-${field}:${value}`,
        siteWide: true,
        page: urls[0],
        message: `Same ${label} on ${urls.length} pages: "${value.slice(0, 80)}"`,
        detail: { pages: urls },
      });
    }
  }

  return { checked: htmlPages.length, issues };
}

/**
 * [severity, key, message, detail] when the canonical link points somewhere other than this page, else null.
 * Compared normalized, so a trailing slash or #fragment doesn't count as different.
 */
function canonicalProblem(page, href, crawled, siteUrl) {
  const target = normalizeUrl(href);
  if (!target) return ['warning', 'canonical-invalid', `Canonical link is not a valid URL: "${href}"`, { canonical: href }];
  if ([page.url, page.finalUrl].map(normalizeUrl).includes(target)) return null;
  const detail = { canonical: target };
  if (siteUrl && !sameSite(target, siteUrl)) return ['warning', 'canonical-cross-site', `Canonical points to another site: ${target}`, detail];
  const label = new URL(target).origin === new URL(page.finalUrl || page.url).origin ? pathOf(target) : target;
  const t = crawled.get(target);
  if (t && (t.error || t.status >= 400)) {
    const why = t.error ? `is unreachable (${t.error})` : `returns ${t.status}`;
    return ['critical', 'canonical-broken', `Canonical points to ${label}, which ${why}`, { ...detail, status: t.status, error: t.error }];
  }
  return ['warning', 'canonical-other', `Canonical points to ${label}`, detail];
}

/**
 * One site-wide warning when no crawled page declares an icon and /favicon.ico doesn't load either.
 * Null when there is a favicon, or nothing was crawled to judge by.
 */
export async function checkFavicon(pages, site, config) {
  const htmlPages = pages.filter((p) => p.isHtml && p.status < 400 && p.data?.meta && !p.data.meta.error);
  if (!htmlPages.length || htmlPages.some((p) => p.data.meta.hasIcon)) return null;
  const start = pages.find((p) => p.source === 'start') || htmlPages[0];
  const url = new URL('/favicon.ico', start.finalUrl || start.url || site.url).href;
  let status = null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': config.userAgent, ...authHeaders(config, url) },
      signal: AbortSignal.timeout(config.timeoutMs || 10000),
    });
    res.body?.cancel().catch(() => {});
    status = res.status;
    if (res.ok) return null;
  } catch {}
  return {
    check: 'meta',
    severity: 'warning',
    key: 'favicon',
    siteWide: true,
    page: start.url,
    message: `No favicon: no <link rel="icon"> and /favicon.ico ${status ? `returns ${status}` : 'is unreachable'}`,
    detail: { url, status },
  };
}

function resolve(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function shortSrc(src, page) {
  if (!src) return '(no src)';
  if (src.startsWith('data:')) return 'data: URI';
  const s = sameSite(src, page.url) ? pathOf(src) : src;
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
