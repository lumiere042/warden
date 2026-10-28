export default {
  name: 'performance',
  title: 'Speed',
  run: async ({ pages, config, previous, site }) => checkPerformance(pages, config, previous, site),
};

/**
 * Flag pages over the configured thresholds. Anything over 2x a threshold is critical.
 * Timings are noisy, so with a previous run there's hysteresis: a page/metric that wasn't flagged
 * last time must exceed its limit by thresholds.marginPct (default 10%); one that was flagged
 * stays flagged while it's over the plain limit. Without a previous run the plain limit applies.
 */
export function checkPerformance(pages, config, previous = null, site = null) {
  const t = config.thresholds;
  const marginPct = t.marginPct ?? 10;
  const issues = [];
  const measured = pages.filter((p) => p.perf);
  const flaggedBefore = previouslyFlagged(previous, site);

  for (const page of measured) {
    const p = page.perf;
    const checks = [
      ['load', p.loadMs, t.loadMs, (v) => `Load time ${fmtMs(v)} (limit ${fmtMs(t.loadMs)})`],
      ['lcp', p.lcpMs, t.lcpMs, (v) => `Largest Contentful Paint ${fmtMs(v)} (limit ${fmtMs(t.lcpMs)})`],
      ['weight', p.transferKb, t.pageWeightKb, (v) => `Page weight ${fmtKb(v)} (limit ${fmtKb(t.pageWeightKb)})`],
      ['cls', p.cls, t.clsScore, (v) => `Layout shift (CLS) ${fmtCls(v)} (limit ${fmtCls(t.clsScore)})`],
    ];
    for (const [key, value, limit, msg] of checks) {
      if (value == null || !limit || value <= limit) continue;
      const wasFlagged = flaggedBefore?.has(`${page.url}|${key}`);
      const marginLimit = Math.round(limit * (1 + marginPct / 100) * 1000) / 1000;
      // Over the limit but within the margin, and fine last run: likely noise, wait for a clear signal.
      if (flaggedBefore && !wasFlagged && value <= marginLimit) continue;
      issues.push({
        check: 'performance',
        severity: value > limit * 2 ? 'critical' : 'warning',
        key,
        page: page.url,
        message: msg(value),
        detail: {
          ...p,
          // kept: flagged last run, so the plain limit applies; margin: had to beat limit + marginPct; null: no previous run
          hysteresis: !flaggedBefore ? null : wasFlagged ? { applied: 'kept', limit } : { applied: 'margin', limit: marginLimit, marginPct },
        },
      });
    }
  }

  const avg = (k, digits = 0) => {
    const vals = measured.map((p) => p.perf[k]).filter((v) => v != null);
    const f = 10 ** digits;
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * f) / f : null;
  };
  const slowest = [...measured]
    .sort((a, b) => (b.perf.loadMs ?? 0) - (a.perf.loadMs ?? 0))
    .slice(0, 5)
    .map((p) => ({ url: p.url, ...p.perf }));

  return {
    checked: measured.length,
    issues,
    summary: { avgLoadMs: avg('loadMs'), avgLcpMs: avg('lcpMs'), avgTransferKb: avg('transferKb'), avgCls: avg('cls', 3), slowest },
  };
}

/** `${page}|${key}` of the performance issues saved last run (for this site, when known), or null without a previous run. */
function previouslyFlagged(previous, site) {
  if (!previous) return null;
  const marker = '|performance|';
  const flagged = new Set();
  for (const { id } of previous.issues || []) {
    const at = id?.indexOf(marker) ?? -1;
    if (at < 0 || (site && id.slice(0, at) !== site.url)) continue;
    flagged.add(id.slice(at + marker.length));
  }
  return flagged;
}

export const fmtMs =(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
export const fmtKb = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}MB` : `${v}KB`);
export const fmtCls = (v) => (v == null ? '–' : v.toFixed(2));
