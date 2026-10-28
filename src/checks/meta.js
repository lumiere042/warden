/** SEO / meta-tag checks per page, plus site-wide duplicate detection. */
export function checkMeta(pages) {
  const issues = [];
  const htmlPages = pages.filter((p) => p.isHtml && p.meta && p.status && p.status < 400);
  const add = (page, severity, key, message) => issues.push({ check: 'meta', severity, key, page: page.url, message });

  for (const page of htmlPages) {
    const m = page.meta;
    if (!m.title) add(page, 'critical', 'title-missing', 'Missing <title>');
    else if (m.title.length < 10 || m.title.length > 60) add(page, 'warning', 'title-length', `Title is ${m.title.length} chars (aim for 10–60)`);

    if (!m.description) add(page, 'warning', 'description-missing', 'Missing meta description');
    else if (m.description.length < 50 || m.description.length > 160)
      add(page, 'warning', 'description-length', `Meta description is ${m.description.length} chars (aim for 50–160)`);

    if (!m.viewport) add(page, 'warning', 'viewport', 'Missing viewport meta tag (page will not scale on mobile)');
    if (!m.lang) add(page, 'warning', 'lang', 'Missing <html lang> attribute');
    if (!m.canonical) add(page, 'warning', 'canonical', 'Missing canonical link');
    if (m.h1Count === 0) add(page, 'warning', 'h1-missing', 'No <h1> on page');
    if (m.h1Count > 1) add(page, 'warning', 'h1-multiple', `${m.h1Count} <h1> tags on page (use one)`);

    const missingOg = [['og:title', m.ogTitle], ['og:description', m.ogDescription], ['og:image', m.ogImage]]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missingOg.length) add(page, 'warning', 'open-graph', `Missing ${missingOg.join(', ')} (link previews on social media)`);

    if (m.robots && /noindex/i.test(m.robots)) add(page, 'critical', 'noindex', `Page is marked noindex ("${m.robots}") — search engines will drop it`);
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
        page: urls[0],
        message: `Same ${label} on ${urls.length} pages: "${value.slice(0, 80)}"`,
        detail: { pages: urls },
      });
    }
  }

  return { checked: htmlPages.length, issues };
}
