import fs from 'node:fs';
import path from 'node:path';
import { CHECKS } from '../checks/index.js';

// Site-wide issues (a broken URL found on many pages, a duplicate title) are identified by key alone,
// so a different crawl order doesn't turn the same problem into one "fixed" and one "new".
const issueId = (siteUrl, i) => (i.siteWide ? `${siteUrl}|${i.check}|${i.key}` : `${siteUrl}|${i.check}|${i.page}|${i.key}`);
const legacyId = (siteUrl, i) => `${siteUrl}|${i.check}|${i.page}|${i.key}`;

/**
 * The config `ignore` rule an issue matches, if any. All fields a rule gives must match:
 * check exactly; key, page (path or full URL) and match (the message) as substrings.
 */
export function ignoreRuleFor(issue, rules = []) {
  return rules.find(
    (r) =>
      (!r.check || issue.check === r.check) &&
      (!r.key || String(issue.key ?? '').includes(r.key)) &&
      (!r.page || String(issue.page ?? '').includes(r.page)) &&
      (!r.match || String(issue.message ?? '').includes(r.match))
  );
}

/**
 * Combine per-site results, then mark issues new/fixed relative to the previous run.
 * Each site result is { site, pages, checks: { [check name]: result } }.
 * Issues matching an `ignore` rule go to site.ignored instead of site.issues and the counts.
 */
export function buildReport(siteResults, previous, { ignore = [] } = {}) {
  const prevIds = new Map((previous?.issues || []).map((i) => [i.id, i]));
  const currentIds = new Set();

  const sites = siteResults.map((r) => {
    // Older callers passed { links, forms, meta, performance } next to site and pages.
    const results = r.checks || { links: r.links, forms: r.forms, meta: r.meta, performance: r.performance };
    const ran = CHECKS.filter((c) => results[c.name]);
    const ignored = [];
    const issues = ran
      .flatMap((c) => results[c.name].issues.map((i) => ({ ...i, check: i.check || c.name })))
      .filter((i) => {
        const rule = ignoreRuleFor(i, ignore);
        if (!rule) return true;
        const id = issueId(r.site.url, i);
        // Still "current", so an issue that was there last run doesn't show up as fixed.
        currentIds.add(id);
        if (i.siteWide) currentIds.add(legacyId(r.site.url, i));
        ignored.push({ ...i, id, reason: rule.reason || null });
        return false;
      })
      .map((i) => {
        const id = issueId(r.site.url, i);
        currentIds.add(id);
        // Reports saved before site-wide ids existed used the page-based id; treat those as the same issue.
        const legacy = i.siteWide && prevIds.has(legacyId(r.site.url, i)) ? legacyId(r.site.url, i) : null;
        if (legacy) currentIds.add(legacy);
        return { ...i, id, isNew: previous ? !prevIds.has(id) && !legacy : false };
      })
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

    const count = (check, sev) => issues.filter((i) => i.check === check && (!sev || i.severity === sev)).length;
    return {
      url: r.site.url,
      pagesCrawled: r.pages.length,
      linksChecked: results.links?.checked ?? 0,
      issues,
      ignored,
      fixed: [],
      formResults: results.forms?.results || [],
      untestedForms: results.forms?.untested || [],
      performance: results.performance?.summary || null,
      checks: Object.fromEntries(
        ran.map((c) => {
          const res = results[c.name];
          return [c.name, { title: c.title, checked: res.checked ?? 0, summary: res.summary ?? null, ...(res.error ? { error: res.error } : {}) }];
        })
      ),
      counts: {
        critical: issues.filter((i) => i.severity === 'critical').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        new: issues.filter((i) => i.isNew).length,
        ignored: ignored.length,
        brokenLinks: count('links', 'critical'),
        meta: count('meta'),
        slowPages: new Set(issues.filter((i) => i.check === 'performance').map((i) => i.page)).size,
        brokenForms: count('forms'),
        byCheck: Object.fromEntries(ran.map((c) => [c.name, { critical: count(c.name, 'critical'), warning: count(c.name, 'warning') }])),
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

export function saveReport(dir, report, html, previous = null) {
  fs.mkdirSync(dir, { recursive: true });
  // e.g. 2026-10-28_1543_example.com — one file per run, so runs on the same day don't overwrite each other.
  const time = report.generatedAt.slice(0, 16).replace('T', '_').replace(':', '');
  const hosts = report.sites.map((s) => new URL(s.url).host.replace(/[^a-z0-9.-]/gi, '-')).join('+');
  const base = `${time}_${hosts}`.slice(0, 120);
  const htmlPath = path.join(dir, `${base}.html`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(report, null, 2));

  // Only what's needed for the next run's new/fixed diff. Keep other sites' history,
  // so checking site A doesn't make site B's issues all look "new" next time.
  const current = report.sites.flatMap((s) => s.issues.map(({ id, check, page, message, severity }) => ({ id, check, page, message, severity })));
  const otherSites = (previous?.issues || []).filter((i) => !report.sites.some((s) => i.id.startsWith(`${s.url}|`)));
  const last = { generatedAt: report.generatedAt, issues: [...otherSites, ...current] };
  fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify(last, null, 2));
  return htmlPath;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function subjectLine(report) {
  const parts = report.sites.map((s) => {
    const host = new URL(s.url).host;
    const c = s.counts;
    const bits = [];
    if (s.issues.some((i) => i.check === 'pages' && i.key === 'site-down')) bits.push('site unreachable');
    if (c.brokenLinks) bits.push(plural(c.brokenLinks, 'broken link'));
    if (c.brokenForms) bits.push(plural(c.brokenForms, 'broken form'));
    if (c.slowPages) bits.push(plural(c.slowPages, 'slow page'));
    if (c.meta) bits.push(plural(c.meta, 'SEO issue'));
    // Any other check: mention its critical issues, e.g. "pages: 2 critical".
    for (const [name, n] of Object.entries(c.byCheck || {})) {
      if (['links', 'forms', 'performance', 'meta'].includes(name)) continue;
      const critical = n.critical - (name === 'pages' && bits[0] === 'site unreachable' ? 1 : 0);
      if (critical > 0) bits.push(`${(s.checks?.[name]?.title || name).toLowerCase()}: ${critical} critical`);
    }
    if (!bits.length && c.warning) bits.push(plural(c.warning, 'warning'));
    const summary = bits.length ? bits.join(', ') : 'all clear';
    return `${host} — ${summary}${c.new ? ` (${c.new} new)` : ''}`;
  });
  return `QA ${parts.join(' | ')}`;
}
