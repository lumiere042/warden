import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Visual changes: screenshot up to visual.maxPages pages per site and compare them with the
 * baseline from an earlier run. Off by default ("visual": { "enabled": true } in the config).
 *
 * Files live in <outDir>/screenshots/<host>/{current,baseline,diff}/<slug>.png. The first run of a
 * page saves its baseline. Later runs keep that baseline, so a change stays reported until it is
 * accepted with visual.updateBaseline / --update-baseline (which then copies current over baseline).
 */
export default {
  name: 'visual',
  title: 'Visual changes',
  enabled: (config) => Boolean(config.visual?.enabled),

  async collect({ page, result, site, config, outDir }) {
    const opts = config.visual;
    if (!opts?.enabled || !outDir) return;
    // collect() runs for several pages at once: claim a slot before the first await.
    const state = runState(config, site.url);
    if (state.taken >= (opts.maxPages ?? 10)) return;
    state.taken++;

    const slug = slugFor(result.url);
    const file = path.join(screenshotDir(outDir, site.url, 'current'), `${slug}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // With a device (mobile run) keep the device's viewport, otherwise use a fixed one so runs compare.
    if (!config.device && opts.viewport) await page.setViewportSize(opts.viewport);
    await page.screenshot({ path: file, fullPage: Boolean(opts.fullPage), animations: 'disabled', caret: 'hide', timeout: 15000 });
    result.data.visual = { slug };
  },

  async run({ pages, site, config, outDir, log }) {
    const opts = config.visual || {};
    const visualRuns = runs.get(config);
    visualRuns?.delete(site.url);
    if (!opts.enabled || !outDir) return { checked: 0, issues: [] };

    const rel = (kind, slug) => `screenshots/${hostDir(site.url)}/${kind}/${slug}.png`;
    const abs = (kind, slug) => path.join(outDir, ...rel(kind, slug).split('/'));
    const issues = [];
    const summary = { screenshots: 0, baselined: 0, changed: 0, accepted: 0 };

    for (const p of pages) {
      const slug = p.data?.visual?.slug;
      if (!slug || !fs.existsSync(abs('current', slug))) continue;
      summary.screenshots++;
      const [current, baseline, diff] = ['current', 'baseline', 'diff'].map((k) => abs(k, slug));
      fs.mkdirSync(path.dirname(baseline), { recursive: true });
      if (!fs.existsSync(baseline)) {
        fs.copyFileSync(current, baseline);
        summary.baselined++;
        continue;
      }

      const cmp = compare(current, baseline, diff, opts);
      if (cmp.changed && opts.updateBaseline) summary.accepted++;
      else if (cmp.changed) {
        summary.changed++;
        const detail = { current: rel('current', slug), baseline: rel('baseline', slug) };
        if (cmp.sizeChange) {
          issues.push({ severity: 'warning', key: 'visual', page: p.url, message: `Page size changed (${cmp.sizeChange})`, detail: { ...detail, sizeChange: cmp.sizeChange } });
        } else {
          issues.push({ severity: 'warning', key: 'visual', page: p.url, message: `${cmp.diffPct}% of the page changed since the baseline`, detail: { ...detail, diffPct: cmp.diffPct, diffImage: rel('diff', slug) } });
        }
      }
      if (opts.updateBaseline) fs.copyFileSync(current, baseline);
    }
    if (summary.accepted) log(`  visual: accepted ${summary.accepted} changed screenshot(s) as the new baseline`);
    return { checked: summary.screenshots, issues, summary };
  },
};

/** Compare two PNG files. Writes a diff image when more than maxDiffPct of the pixels differ. */
export function compare(currentFile, baselineFile, diffFile, { threshold = 0.1, maxDiffPct = 1 } = {}) {
  const a = PNG.sync.read(fs.readFileSync(currentFile));
  const b = PNG.sync.read(fs.readFileSync(baselineFile));
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, sizeChange: `${b.width}×${b.height} → ${a.width}×${a.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  const diffPct = Math.round((pixels / (a.width * a.height)) * 1000) / 10;
  if (diffPct <= maxDiffPct) {
    fs.rmSync(diffFile, { force: true });
    return { changed: false, diffPct };
  }
  fs.mkdirSync(path.dirname(diffFile), { recursive: true });
  fs.writeFileSync(diffFile, PNG.sync.write(diff));
  return { changed: true, diffPct };
}

// Screenshots taken per site in the current run. Keyed by the run's config object (each run loads
// its own), and cleared by run(), so a cancelled or repeated run never inherits an old count.
const runs = new WeakMap();
function runState(config, siteUrl) {
  if (!runs.has(config)) runs.set(config, new Map());
  const sites = runs.get(config);
  if (!sites.has(siteUrl)) sites.set(siteUrl, { taken: 0 });
  return sites.get(siteUrl);
}

/** Same folder name rule as the report files: example.com, localhost-8080. */
export const hostDir = (siteUrl) => new URL(siteUrl).host.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
const screenshotDir = (outDir, siteUrl, kind) => path.join(outDir, 'screenshots', hostDir(siteUrl), kind);

/** "/blog/post?id=2" -> "blog-post-id-2-1a2b3c4d": readable, filesystem-safe, unique per URL path. */
export function slugFor(url) {
  let key = url;
  try {
    const u = new URL(url);
    key = u.pathname + u.search;
  } catch {}
  const readable = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'home';
  return `${readable}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
}
