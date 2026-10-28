import fs from 'node:fs';
import path from 'node:path';

const issueId = (siteUrl, i) => `${siteUrl}|${i.check}|${i.page}|${i.key}`;

/** Combine per-site results, then mark issues new/fixed relative to the previous run. */
export function buildReport(siteResults, previous) {
  const prevIds = new Map((previous?.issues || []).map((i) => [i.id, i]));
  const currentIds = new Set();

  const sites = siteResults.map((r) => {
    const issues = [...r.links.issues, ...r.forms.issues, ...r.meta.issues, ...r.performance.issues]
      .map((i) => {
        const id = issueId(r.site.url, i);
        currentIds.add(id);
        return { ...i, id, isNew: previous ? !prevIds.has(id) : false };
      })
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

    const count = (check, sev) => issues.filter((i) => i.check === check && (!sev || i.severity === sev)).length;
    return {
      url: r.site.url,
      pagesCrawled: r.pages.length,
      linksChecked: r.links.checked,
      issues,
      fixed: [],
      formResults: r.forms.results,
      untestedForms: r.forms.untested,
      performance: r.performance.summary,
      counts: {
        critical: issues.filter((i) => i.severity === 'critical').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        new: issues.filter((i) => i.isNew).length,
        brokenLinks: count('links', 'critical'),
        meta: count('meta'),
        slowPages: new Set(issues.filter((i) => i.check === 'performance').map((i) => i.page)).size,
        brokenForms: count('forms'),
      },
    };
  });

  // Fixed = was in the last run for one of these sites, and isn't now.
  for (const prev of previous?.issues || []) {
    if (currentIds.has(prev.id)) continue;
    const site = sites.find((s) => prev.id.startsWith(`${s.url}|`));
    if (site) site.fixed.push(prev);
  }

  return { generatedAt: new Date().toISOString(), sites };
}

export function loadPrevious(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function saveReport(dir, report, html) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.generatedAt.slice(0, 10);
  const htmlPath = path.join(dir, `${stamp}.html`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
  // Only what's needed for tomorrow's new/fixed diff.
  const last = { generatedAt: report.generatedAt, issues: report.sites.flatMap((s) => s.issues.map(({ id, check, page, message, severity }) => ({ id, check, page, message, severity }))) };
  fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify(last, null, 2));
  return htmlPath;
}

export function subjectLine(report) {
  const parts = report.sites.map((s) => {
    const host = new URL(s.url).host;
    const c = s.counts;
    const bits = [];
    if (c.brokenLinks) bits.push(`${c.brokenLinks} broken link${c.brokenLinks === 1 ? '' : 's'}`);
    if (c.brokenForms) bits.push(`${c.brokenForms} broken form${c.brokenForms === 1 ? '' : 's'}`);
    if (c.slowPages) bits.push(`${c.slowPages} slow page${c.slowPages === 1 ? '' : 's'}`);
    if (c.meta) bits.push(`${c.meta} SEO issue${c.meta === 1 ? '' : 's'}`);
    const summary = bits.length ? bits.join(', ') : 'all clear';
    return `${host} — ${summary}${c.new ? ` (${c.new} new)` : ''}`;
  });
  return `QA ${parts.join(' | ')}`;
}
