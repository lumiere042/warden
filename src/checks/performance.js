export default {
  name: 'performance',
  title: 'Speed',
  run: async ({ pages, config }) => checkPerformance(pages, config),
};

/** Flag pages over the configured thresholds. Anything over 2x a threshold is critical. */
export function checkPerformance(pages, config) {
  const t = config.thresholds;
  const issues = [];
  const measured = pages.filter((p) => p.perf);

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
      issues.push({
        check: 'performance',
        severity: value > limit * 2 ? 'critical' : 'warning',
        key,
        page: page.url,
        message: msg(value),
        detail: p,
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

export const fmtMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
export const fmtKb = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}MB` : `${v}KB`);
export const fmtCls = (v) => (v == null ? '–' : v.toFixed(2));
