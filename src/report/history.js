import fs from 'node:fs';
import path from 'node:path';

const MAX_RUNS = 200;
const MAX_FILES = 2000; // newest report files read when listing every site

/**
 * Run history from the saved report JSON files in `dir` (last.json excluded; unreadable files skipped).
 * With `site` (an origin or a host): { site, runs: [...] }, oldest run first, at most the latest 200.
 * Without: { sites: [{ site, url, runs, latest }] }, most recently checked site first.
 * Older reports lack some fields (byCheck, avgCls, checks); those come back as null.
 */
export function readHistory(dir, site) {
  const host = site ? hostOf(site) : null;
  if (site && !host) return { site: null, runs: [] };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'last.json');
  } catch {}
  // Newest first by file name (it starts with the time). A site's runs have its host in the name,
  // unless a long multi-site name was cut short (120 chars).
  names.sort().reverse();
  if (host) {
    const slug = host.replace(/[^a-z0-9.-]/gi, '-');
    names = names.filter((n) => n.includes(slug) || n.length >= 125);
  } else {
    names = names.slice(0, MAX_FILES);
  }

  const runs = [];
  for (const name of names) {
    const report = readJson(path.join(dir, name));
    if (!report || !Array.isArray(report.sites) || !validDate(report.generatedAt)) continue;
    for (const s of report.sites) {
      const h = s && hostOf(s.url);
      if (!h || (host && h !== host)) continue;
      runs.push(runEntry(report, s, name, h));
    }
    if (host && runs.length >= MAX_RUNS) break;
  }
  runs.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));

  if (host) return { site: host, runs: runs.slice(-MAX_RUNS) };
  const bySite = new Map();
  for (const r of runs) {
    const entry = bySite.get(r.site) || { site: r.site, url: r.url, runs: 0, latest: null };
    entry.runs++;
    entry.latest = { generatedAt: r.generatedAt, critical: r.critical, warning: r.warning, reportUrl: r.reportUrl, reportJsonUrl: r.reportJsonUrl };
    entry.url = r.url;
    bySite.set(r.site, entry);
  }
  return { sites: [...bySite.values()].sort((a, b) => b.latest.generatedAt.localeCompare(a.latest.generatedAt)) };
}

function runEntry(report, s, name, host) {
  const c = s.counts || {};
  const perf = s.performance || s.checks?.performance?.summary || {};
  const base = encodeURIComponent(name.replace(/\.json$/, ''));
  return {
    site: host,
    url: s.url,
    generatedAt: new Date(report.generatedAt).toISOString(),
    critical: num(c.critical),
    warning: num(c.warning),
    new: num(c.new),
    fixed: Array.isArray(s.fixed) ? s.fixed.length : null,
    pagesCrawled: num(s.pagesCrawled),
    byCheck: c.byCheck && typeof c.byCheck === 'object' ? c.byCheck : null,
    avgLoadMs: num(perf.avgLoadMs),
    avgLcpMs: num(perf.avgLcpMs),
    avgCls: num(perf.avgCls),
    reportUrl: `/reports/${base}.html`,
    reportJsonUrl: `/reports/${base}.json`,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** "https://Example.com/x" or "example.com:8080" -> "example.com" / "example.com:8080". */
function hostOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const validDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
