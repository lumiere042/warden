import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { loadConfig } from '../src/config.js';
import { runQa } from '../src/run.js';
import { startServer } from '../src/server.js';
import { compare, slugFor, hostDir } from '../src/checks/visual.js';

let fixture, base, outDir, configPath;
let banner = '#3d5afe'; // the big block on the home page; change it to make a visual change

before(async () => {
  fixture = http.createServer((req, res) => {
    const body = req.url === '/'
      ? `<div style="height:420px;background:${banner}"></div><a href="/two">Two</a>`
      : '<h1>Page two</h1><a href="/">Home</a>';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>Visual fixture page</title></head><body style="margin:0">${body}</body></html>`);
  });
  await new Promise((r) => fixture.listen(0, r));
  base = `http://localhost:${fixture.address().port}`;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-visual-'));
  configPath = path.join(outDir, 'qa.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ sites: [{ url: base, maxPages: 2 }], checkExternalLinks: false, visual: { enabled: true } }));
});

after(() => fixture?.close());

async function scan(visual = {}) {
  const config = loadConfig({ configPath });
  Object.assign(config.visual, visual);
  const { report } = await runQa(config, { outDir, ai: false, email: false });
  const s = report.sites[0];
  return { issues: s.issues.filter((i) => i.check === 'visual'), summary: s.checks.visual?.summary, checks: s.checks };
}

const shots = (kind) => path.join(outDir, 'screenshots', hostDir(base), kind);
const homeSlug = () => slugFor(`${base}/`);

test('off by default; partial config keeps the other defaults', () => {
  const plain = path.join(outDir, 'plain.json');
  fs.writeFileSync(plain, JSON.stringify({ sites: [{ url: 'https://example.com' }] }));
  assert.equal(loadConfig({ configPath: plain }).visual.enabled, false);
  const c = loadConfig({ configPath });
  assert.equal(c.visual.enabled, true);
  assert.equal(c.visual.maxPages, 10);
  assert.deepEqual(c.visual.viewport, { width: 1280, height: 800 });
});

test('visual check: baseline, unchanged, changed, accepted', async () => {
  // Turned off: no screenshots, and no section in the report.
  let run = await scan({ enabled: false });
  assert.equal(run.checks.visual, undefined);
  assert.ok(run.checks.links, 'the other checks still run');
  assert.ok(!fs.existsSync(path.join(outDir, 'screenshots')));

  // First run: no baseline yet, so it is saved and nothing is reported.
  run = await scan();
  assert.deepEqual(run.issues, []);
  assert.equal(run.summary.baselined, 2);
  assert.ok(fs.existsSync(path.join(shots('baseline'), `${homeSlug()}.png`)));

  // Same content, one screenshot allowed: still nothing.
  run = await scan({ maxPages: 1 });
  assert.deepEqual(run.issues, []);
  assert.equal(run.summary.screenshots, 1);

  // Changed home page: reported with a diff image.
  banner = '#ff5d5d';
  run = await scan();
  assert.equal(run.issues.length, 1, JSON.stringify(run.issues));
  const issue = run.issues[0];
  assert.equal(issue.key, 'visual');
  assert.equal(issue.severity, 'warning');
  assert.equal(new URL(issue.page).pathname, '/');
  assert.match(issue.message, /^\d+(\.\d)?% of the page changed since the baseline$/);
  assert.ok(issue.detail.diffPct > 1);
  assert.ok(fs.existsSync(path.join(outDir, ...issue.detail.diffImage.split('/'))), 'diff image written');
  assert.equal(issue.detail.baseline, `screenshots/${hostDir(base)}/baseline/${homeSlug()}.png`);

  // The baseline is kept, so the change is reported again until accepted.
  run = await scan();
  assert.equal(run.issues.length, 1);

  // --update-baseline accepts it...
  run = await scan({ updateBaseline: true });
  assert.deepEqual(run.issues, []);
  assert.equal(run.summary.accepted, 1);
  // ...and from then on the new look is the baseline.
  run = await scan();
  assert.deepEqual(run.issues, []);
});

test('compare: size change, small diffs under the limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-visual-cmp-'));
  const png = (name, w, h, paint = () => [255, 255, 255]) => {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      img.data.set([r, g, b, 255], (y * w + x) * 4);
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, PNG.sync.write(img));
    return file;
  };
  const a = png('a.png', 100, 100);
  const diff = path.join(dir, 'diff.png');
  assert.deepEqual(compare(png('tall.png', 100, 150), a, diff), { changed: true, sizeChange: '100×100 → 100×150' });
  // 1 changed pixel out of 10,000: under the 1% default.
  const speck = compare(png('speck.png', 100, 100, (x, y) => (x === 5 && y === 5 ? [0, 0, 0] : [255, 255, 255])), a, diff);
  assert.equal(speck.changed, false);
  assert.ok(!fs.existsSync(diff));
  const half = compare(png('half.png', 100, 100, (x) => (x < 50 ? [0, 0, 0] : [255, 255, 255])), a, diff, { maxDiffPct: 1 });
  assert.deepEqual(half, { changed: true, diffPct: 50 });
  assert.ok(fs.existsSync(diff));
});

test('slugs are filesystem safe and unique per path', () => {
  assert.match(slugFor('https://x.com/'), /^home-[0-9a-f]{8}$/);
  assert.match(slugFor('https://x.com/Blog/Post?id=2'), /^blog-post-id-2-[0-9a-f]{8}$/);
  assert.notEqual(slugFor('https://x.com/a-b'), slugFor('https://x.com/a/b'));
});

test('serves screenshots and rejects traversal', async () => {
  const app = await startServer({ port: 0, outDir, configPath, log: () => {} });
  try {
    const ok = await fetch(`${app.url}/screenshots/${hostDir(base)}/baseline/${homeSlug()}.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...Buffer.from(await ok.arrayBuffer()).subarray(1, 4)], [...Buffer.from('PNG')]);

    for (const bad of [
      `/screenshots/${hostDir(base)}/baseline/..%2F..%2F..%2Fqa.config.json`,
      `/screenshots/..%2F..%2Fpackage.json`,
      `/screenshots/../baseline/${homeSlug()}.png`,
      `/screenshots/${hostDir(base)}/secret/${homeSlug()}.png`,
      `/screenshots/${hostDir(base)}/baseline/missing.png`,
      `/screenshots/${hostDir(base)}/baseline/${homeSlug()}.txt`,
    ]) {
      const res = await rawGet(app.url, bad);
      assert.equal(res, 404, bad);
    }
    const foreign = await rawGet(app.url, `/screenshots/${hostDir(base)}/baseline/${homeSlug()}.png`, { host: 'evil.example' });
    assert.equal(foreign, 403, 'Host check applies to screenshots too');
  } finally {
    await app.close();
  }
});

/** Raw request so the path isn't normalized by fetch() and Host can be forged. */
function rawGet(baseUrl, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request({ hostname: '127.0.0.1', port: u.port, path: p, headers: { host: u.host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
