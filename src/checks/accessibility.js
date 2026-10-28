import { AxeBuilder } from '@axe-core/playwright';
import { sameSite } from '../util.js';

const IMPACT = { critical: 4, serious: 3, moderate: 2, minor: 1 };

// The config is merged shallowly, so a partial "accessibility" block still gets the defaults.
const settings = (config = {}) => {
  const a = config.accessibility || {};
  return { enabled: a.enabled !== false, tags: a.tags?.length ? a.tags : ['wcag2a', 'wcag2aa'], disableRules: a.disableRules || [] };
};

/**
 * axe-core audit of every crawled page (WCAG A + AA rules by default), grouped by rule across
 * the site: one issue per rule, listing the pages it fails on. Critical-impact rules are
 * critical issues, everything else is a warning.
 */
export default {
  name: 'accessibility',
  title: 'Accessibility',

  async collect({ page, result, site, config }) {
    const opts = settings(config);
    // Error pages and pages that redirected off-site aren't worth auditing.
    if (!opts.enabled || !result.isHtml || result.status >= 400 || page.isClosed() || !sameSite(result.finalUrl, site.url)) return;
    let axe = new AxeBuilder({ page }).withTags(opts.tags);
    if (opts.disableRules.length) axe = axe.disableRules(opts.disableRules);
    const ms = config.pageTimeoutMs || 30000;
    let timer;
    try {
      const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`axe timed out after ${ms} ms`)), ms)));
      const { violations } = await Promise.race([axe.analyze(), timeout]);
      result.data.accessibility = {
        violations: violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => n.target.flat().join(' ')),
        })),
      };
    } catch (err) {
      result.data.accessibility = { error: err.message.split('\n')[0] };
    } finally {
      clearTimeout(timer);
    }
  },

  run: async ({ pages, config }) => checkAccessibility(pages, config),
};

export function checkAccessibility(pages, config) {
  if (!settings(config).enabled) return { checked: 0, issues: [] };
  const audited = pages.filter((p) => p.data?.accessibility?.violations);
  const rules = new Map();
  for (const p of audited) {
    for (const v of p.data.accessibility.violations) {
      if (!rules.has(v.id)) rules.set(v.id, { ...v, nodes: 0, pages: [], targets: [] });
      const r = rules.get(v.id);
      if ((IMPACT[v.impact] || 0) > (IMPACT[r.impact] || 0)) r.impact = v.impact;
      r.nodes += v.nodes;
      if (!r.pages.includes(p.url)) r.pages.push(p.url);
      if (r.targets.length < 3) r.targets.push(...v.targets.slice(0, 3 - r.targets.length));
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const issues = [...rules.values()]
    .sort((a, b) => (IMPACT[b.impact] || 0) - (IMPACT[a.impact] || 0) || b.nodes - a.nodes)
    .map((r) => ({
      check: 'accessibility',
      severity: r.impact === 'critical' ? 'critical' : 'warning',
      key: r.id,
      siteWide: true,
      page: r.pages[0],
      message: `${r.id}: ${r.help} (${plural(r.nodes, 'element')} on ${plural(r.pages.length, 'page')})`,
      detail: { rule: r.id, impact: r.impact, help: r.help, helpUrl: r.helpUrl, nodes: r.nodes, targets: r.targets, pages: r.pages },
    }));

  const failed = pages.filter((p) => p.data?.accessibility?.error);
  if (failed.length) {
    issues.push({
      check: 'accessibility',
      severity: 'warning',
      key: 'audit-failed',
      siteWide: true,
      page: failed[0].url,
      message: `Accessibility audit failed on ${plural(failed.length, 'page')}: ${failed[0].data.accessibility.error}`,
      detail: { error: failed[0].data.accessibility.error, pages: failed.map((p) => p.url) },
    });
  }

  const elements = issues.reduce((n, i) => n + (i.detail.nodes || 0), 0);
  return { checked: audited.length, issues, summary: { rules: rules.size, elements } };
}
