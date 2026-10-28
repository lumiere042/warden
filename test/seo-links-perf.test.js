import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { crawlSite } from '../src/crawler.js';
import { checkLinks, retryAfterMs } from '../src/checks/links.js';
import { checkMeta, checkFavicon } from '../src/checks/meta.js';
import { checkPerformance } from '../src/checks/performance.js';
import { buildReport, saveReport, subjectLine } from '../src/report/build.js';
import { renderHtml } from '../src/report/html.js';

// A small site with redirects, rate limiting and SEO problems.
let server, base, config, site;
const hits = {};
let active = 0;
let maxActive = 0;

const html = (body, headExtra = '') => `<!doctype html><html lang="en"><head><title>Redirect fixture page</title>${headExtra}</head><body>${body}</body></html>`;

before(async () => {
  server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits[p] = (hits[p] || 0) + 1;
    const redirect = (status, to) => {
      res.writeHead(status, { location: to });
      res.end();
    };
    const send = (status, body = 'ok', type = 'text/html') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (p === '/')
      return send(
        200,
        html(
          `<h1>Home</h1><a href="/old">old</a> <a href="/chain">chain</a> <a href="/new">new</a>
           <img src="/new"> <img src="/img/b.png"> <img src="/img/c.png"> <img src="/img/d.png" alt="">`,
          `<link rel="canonical" href="/other#top"><link rel="alternate" hreflang="english" href="/">`
        )
      );
    if (p === '/old') return redirect(301, '/new');
    if (p === '/chain') return redirect(302, '/chain2');
    if (p === '/chain2') return redirect(301, '/chain3');
    if (p === '/chain3') return redirect(301, '/new');
    if (p === '/new' || p === '/other' || p === '/slash/' || p === '/img/b.png' || p === '/img/c.png') return send(200, html('<h1>New</h1>'));
    if (p === '/slash') return redirect(301, '/slash/');
    if (p === '/loop') return redirect(302, '/loop');
    if (p === '/moved-img') return redirect(301, '/gone-img');
    if (p === '/limited') {
      if (hits[p] === 1) {
        res.writeHead(429, { 'retry-after': '1' });
        return res.end();
      }
      return send(200);
    }
    if (p.startsWith('/asset/')) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return send(200, 'x', 'text/plain');
    }
    return send(404, 'not found', 'text/plain');
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  config = configWith({ sites: [{ url: base }], concurrency: 8 });
  site = config.sites[0];
});

after(() => server?.close());

function configWith(raw) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-slp-')), 'qa.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return loadConfig({ configPath: file });
}

const page = (p, links, extra = {}) => ({
  url: base + p,
  finalUrl: base + p,
  status: 200,
  error: null,
  isHtml: true,
  links: links.map((l) => (typeof l === 'string' ? { kind: 'a', url: l.startsWith('http') ? l : base + l } : l)),
  data: {},
  ...extra,
});

// ---- Links: redirects, per-host limit, 429 ----

test('links: internal redirects and chains are warnings, grouped per URL', async () => {
  const pages = [page('/', ['/old', '/chain', '/new', '/slash', '/slash/']), page('/two', ['/old'])];
  const { issues } = await checkLinks(pages, site, config);
  const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));

  const old = byKey[`redirect:${base}/old`];
  assert.equal(old.severity, 'warning');
  assert.equal(old.message, 'Link redirects (301 → /new)');
  assert.equal(old.siteWide, true);
  assert.deepEqual(old.detail.foundOn.map((u) => new URL(u).pathname), ['/', '/two'], 'one issue for every page linking it');

  assert.equal(byKey[`redirect:${base}/chain`].message, 'Redirect chain (3 hops → /new)');
  assert.deepEqual(byKey[`redirect:${base}/chain`].detail.redirects.map((h) => h.status), [302, 301, 301]);

  // /slash and /slash/ are the same page to the crawler, but only the one without the slash redirects.
  assert.equal(byKey[`redirect:${base}/slash`].message, 'Link redirects (301 → /slash/)');
  assert.ok(!byKey[`redirect:${base}/slash/`], 'the link that already has the slash is fine');
  assert.ok(!issues.some((i) => i.key.endsWith('/new')), 'the redirect target itself is not reported');
});

test('links: crawled pages reuse the redirect chain the browser saw; external redirects are not reported', async () => {
  const before = hits['/crawled-old'] || 0;
  const external = `http://127.0.0.1:${server.address().port}/old`;
  const crawled = page('/crawled-old', [], { finalUrl: `${base}/new`, data: { links: { redirects: [{ url: `${base}/crawled-old`, status: 308 }] } } });
  const pages = [page('/', ['/crawled-old', external]), crawled];
  const { issues } = await checkLinks(pages, site, config);
  assert.equal(issues.find((i) => i.key === `redirect:${base}/crawled-old`).message, 'Link redirects (308 → /new)');
  assert.equal(hits['/crawled-old'] || 0, before, 'crawled page not fetched again');
  assert.ok(!issues.some((i) => i.key.includes('127.0.0.1')), 'external redirect not reported');
});

test('links: redirect loop is unreachable, redirect to a 404 is broken (not a redirect warning)', async () => {
  const pages = [page('/', ['/loop', { kind: 'img', url: `${base}/moved-img` }])];
  const { issues } = await checkLinks(pages, site, config);
  const loop = issues.find((i) => i.key === `${base}/loop`);
  assert.equal(loop.severity, 'critical');
  assert.match(loop.message, /more than 10 redirects/);
  assert.equal(issues.find((i) => i.key === `${base}/moved-img`).message, 'Broken img (404)');
  assert.ok(!issues.some((i) => i.key.startsWith('redirect:')));
});

test('links: at most linkHostConcurrency probes per host; 429 retried after Retry-After', async () => {
  maxActive = 0;
  const assets = Array.from({ length: 8 }, (_, n) => ({ kind: 'img', url: `${base}/asset/${n}` }));
  const { issues } = await checkLinks([page('/', assets)], site, config);
  assert.deepEqual(issues, []);
  assert.equal(maxActive, 2, `default limit is 2 per host (saw ${maxActive})`);

  maxActive = 0;
  await checkLinks([page('/', assets.map((a) => ({ ...a, url: a.url + '?b' })))], site, { ...config, linkHostConcurrency: 4 });
  assert.equal(maxActive, 4);

  const started = Date.now();
  const limited = await checkLinks([page('/', ['/limited'])], site, config);
  assert.deepEqual(limited.issues, [], '429 then 200 is not a broken link');
  assert.equal(hits['/limited'], 2);
  assert.ok(Date.now() - started >= 900, 'waited for Retry-After');

  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('120'), 5000, 'capped at 5s');
  assert.equal(retryAfterMs(null), 1000);
  assert.ok(retryAfterMs(new Date(Date.now() + 3000).toUTCString()) > 1000);
});

// ---- Meta & SEO ----

const meta = (p, m = {}, data = {}, extra = {}) => ({
  ...page(p, []),
  meta: { title: `A good page title ${p}`, description: `A description long enough to pass the length check, for ${p}`, canonical: p, viewport: 'w', lang: 'en', h1Count: 1, ogTitle: 't', ogDescription: 'd', ogImage: 'i', ...m },
  data: { meta: { hasIcon: true, ...data } },
  ...extra,
});

test('meta: canonical pointing elsewhere, to a broken page, or to another site', () => {
  const pages = [
    meta('/a', { canonical: '/a/#section' }), // same page: trailing slash and fragment ignored
    meta('/b', { canonical: '/other' }),
    meta('/c', { canonical: '/broken' }),
    meta('/d', { canonical: 'https://elsewhere.example/d' }),
    meta('/e', { canonical: '/e' }, {}, { url: `${base}/e-old`, finalUrl: `${base}/e` }), // redirected here: canonical matches where we ended up
    { ...page('/broken', []), status: 404 },
  ];
  const { issues } = checkMeta(pages, site);
  const on = (p) => issues.filter((i) => new URL(i.page).pathname === p);
  assert.deepEqual(on('/a'), []);
  assert.deepEqual(on('/e-old'), []);
  assert.equal(on('/b')[0].key, 'canonical-other');
  assert.equal(on('/b')[0].message, 'Canonical points to /other');
  assert.equal(on('/b')[0].severity, 'warning');
  assert.equal(on('/c')[0].key, 'canonical-broken');
  assert.equal(on('/c')[0].severity, 'critical');
  assert.match(on('/c')[0].message, /returns 404/);
  assert.equal(on('/d')[0].key, 'canonical-cross-site');
  assert.equal(on('/d')[0].severity, 'warning');
});

test('meta: images without alt attribute, hreflang codes and self-reference', () => {
  const pages = [
    meta('/imgs', {}, { imgNoAlt: { count: 5, srcs: [`${base}/a.png`, 'https://cdn.example/b.jpg', 'data:image/png;base64,xx'] } }),
    meta('/fine', {}, { imgNoAlt: { count: 0, srcs: [] }, hreflang: [{ lang: 'en', href: `${base}/fine/` }, { lang: 'x-default', href: `${base}/` }, { lang: 'pt-BR', href: `${base}/pt` }] }),
    meta('/bad-lang', {}, { hreflang: [{ lang: 'english', href: `${base}/bad-lang` }, { lang: 'zh-Hant', href: `${base}/zh` }] }),
    meta('/no-self', {}, { hreflang: [{ lang: 'de', href: `${base}/de` }] }),
  ];
  const { issues } = checkMeta(pages, site);
  const key = (p, k) => issues.find((i) => new URL(i.page).pathname === p && i.key === k);

  const img = key('/imgs', 'img-alt');
  assert.equal(img.message, '5 images without an alt attribute: /a.png, https://cdn.example/b.jpg, data: URI, …');
  assert.equal(img.detail.count, 5);
  assert.ok(!issues.some((i) => i.page.endsWith('/fine')), 'valid hreflang set with a self link (trailing slash) is fine');
  assert.equal(key('/bad-lang', 'hreflang-invalid').message, 'Invalid hreflang code: "english"');
  assert.ok(!key('/bad-lang', 'hreflang-self'));
  assert.ok(key('/no-self', 'hreflang-self'));
});

test('meta: favicon missing only when no <link rel=icon> and /favicon.ico fails', async () => {
  const noIcon = [meta('/', {}, { hasIcon: false }, { source: 'start' })];
  const issue = await checkFavicon(noIcon, site, config);
  assert.equal(issue.key, 'favicon');
  assert.equal(issue.siteWide, true);
  assert.match(issue.message, /favicon\.ico returns 404/);

  const before = hits['/favicon.ico'];
  assert.equal(await checkFavicon([meta('/', {}, { hasIcon: true })], site, config), null);
  assert.equal(hits['/favicon.ico'], before, 'not probed when a page declares an icon');

  const ico = http.createServer((req, res) => res.end('icon'));
  await new Promise((r) => ico.listen(0, r));
  const other = `http://localhost:${ico.address().port}`;
  try {
    assert.equal(await checkFavicon([{ ...noIcon[0], url: `${other}/`, finalUrl: `${other}/` }], { url: other }, config), null);
  } finally {
    ico.close();
  }
});

test('crawl: meta and links collect hooks gather canonical, alt, hreflang and redirect data', async () => {
  const browser = await chromium.launch();
  try {
    const pages = await crawlSite(browser, { ...site, maxPages: 3 }, config);
    const home = pages[0];
    assert.equal(home.data.meta.imgNoAlt.count, 3);
    assert.equal(home.data.meta.hasIcon, false);
    assert.equal(home.data.meta.canonicalHref, `${base}/other#top`);

    const old = pages.find((p) => p.url === `${base}/old`);
    assert.deepEqual(old.data.links.redirects, [{ url: `${base}/old`, status: 301 }]);
    const chain = pages.find((p) => p.url === `${base}/chain`);
    assert.equal(chain.data.links.redirects.length, 3);

    const metaIssues = checkMeta(pages, site).issues.filter((i) => i.page === home.url).map((i) => i.key);
    assert.ok(metaIssues.includes('canonical-other'));
    assert.ok(metaIssues.includes('img-alt'));
    assert.ok(metaIssues.includes('hreflang-invalid'));
    const links = await checkLinks(pages, site, config);
    assert.ok(links.issues.some((i) => i.key === `redirect:${base}/old`));
  } finally {
    await browser.close();
  }
});

// ---- Performance hysteresis ----

test('performance: a page must beat the limit by marginPct unless it was flagged last run', () => {
  const s = { url: 'https://perf.test' };
  const cfg = { thresholds: { loadMs: 3000, lcpMs: null, pageWeightKb: null, clsScore: null, marginPct: 10 } };
  const at = (p, loadMs) => ({ url: `${s.url}${p}`, perf: { loadMs } });
  const pages = [at('/near', 3200), at('/kept', 3200), at('/clear', 3400), at('/recovered', 2900)];
  const previous = {
    issues: [
      { id: `${s.url}|performance|${s.url}/kept|load`, check: 'performance' },
      { id: `${s.url}|performance|${s.url}/recovered|load`, check: 'performance' },
      { id: `https://other.test|performance|${s.url}/near|load`, check: 'performance' }, // another site's history doesn't count
    ],
  };
  const flagged = (res) => Object.fromEntries(res.issues.map((i) => [new URL(i.page).pathname, i.detail.hysteresis]));

  const withHistory = flagged(checkPerformance(pages, cfg, previous, s));
  assert.deepEqual(Object.keys(withHistory).sort(), ['/clear', '/kept']);
  assert.deepEqual(withHistory['/kept'], { applied: 'kept', limit: 3000 });
  assert.deepEqual(withHistory['/clear'], { applied: 'margin', limit: 3300, marginPct: 10 });

  // No previous run: plain limits, as before.
  const first = flagged(checkPerformance(pages, cfg, null, s));
  assert.deepEqual(Object.keys(first).sort(), ['/clear', '/kept', '/near']);
  assert.equal(first['/near'], null);

  // Default margin is 10% when the config doesn't set one.
  const noMargin = { thresholds: { loadMs: 3000 } };
  assert.deepEqual(checkPerformance([at('/near', 3250)], noMargin, { issues: [] }, s).issues, []);
});

// ---- Ignore list ----

const issueSet = (u) => [
  { check: 'meta', severity: 'warning', key: 'open-graph', page: `${u}/blog/post`, message: 'Missing og:image (link previews on social media)' },
  { check: 'meta', severity: 'warning', key: 'open-graph', page: `${u}/about`, message: 'Missing og:image (link previews on social media)' },
  { check: 'links', severity: 'critical', key: 'https://partner.example/x', siteWide: true, page: `${u}/`, message: 'Broken a (404)', detail: { url: 'https://partner.example/x', kind: 'a', status: 404, foundOn: [`${u}/`] } },
  { check: 'performance', severity: 'critical', key: 'load', page: `${u}/slow`, message: 'Load time 9.0s (limit 3.0s)' },
];

test('ignore: matching issues leave issues/counts/last.json but are listed with the reason', () => {
  const u = 'https://ign.test';
  const run = { site: { url: u }, pages: [], checks: { meta: { issues: issueSet(u).slice(0, 2) }, links: { issues: [issueSet(u)[2]] }, performance: { issues: [issueSet(u)[3]] } } };
  const ignore = [
    { check: 'meta', key: 'open-graph', page: '/blog/', reason: 'Blog posts use the default image' },
    { key: 'partner.example', reason: 'Partner site blocks bots' },
    { check: 'performance', match: 'Load time', page: '/nowhere' }, // page doesn't match: not ignored
  ];
  const previous = { issues: [{ id: `${u}|links|https://partner.example/x`, message: 'Broken a (404)', page: `${u}/` }] };
  const report = buildReport([run], previous, { ignore });
  const s = report.sites[0];

  assert.deepEqual(s.issues.map((i) => i.page.replace(u, '')).sort(), ['/about', '/slow']);
  assert.equal(s.ignored.length, 2);
  assert.equal(s.ignored.find((i) => i.check === 'links').reason, 'Partner site blocks bots');
  assert.equal(s.counts.ignored, 2);
  assert.equal(s.counts.critical, 1);
  assert.equal(s.counts.warning, 1);
  assert.equal(s.counts.brokenLinks, 0);
  assert.deepEqual(s.fixed, [], 'an ignored issue is not "fixed"');
  assert.doesNotMatch(subjectLine(report), /broken link/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ign-'));
  saveReport(dir, report, '<html></html>');
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'));
  assert.equal(last.issues.length, 2);
  assert.ok(!last.issues.some((i) => i.id.includes('partner.example') || i.page.includes('/blog/')));

  assert.match(renderHtml(report, null), /2 issues ignored by config/);
  assert.doesNotMatch(renderHtml(buildReport([run], null), null), /ignored by config/);
});

test('ignore: config rules are validated', () => {
  assert.throws(() => configWith({ sites: [{ url: 'https://a.test' }], ignore: [{ reason: 'everything' }] }), /ignore\[0\] would ignore every issue/);
  assert.throws(() => configWith({ sites: [{ url: 'https://a.test' }], ignore: [{}] }), /ignore\[0\]/);
  assert.throws(() => configWith({ sites: [{ url: 'https://a.test' }], ignore: [{ check: 'meta' }, { pages: '/x' }] }), /ignore\[1\]: unknown field "pages"/);
  assert.throws(() => configWith({ sites: [{ url: 'https://a.test' }], ignore: { check: 'meta' } }), /must be an array/);
  const ok = configWith({ sites: [{ url: 'https://a.test' }], ignore: [{ check: 'meta', key: 'favicon' }] });
  assert.deepEqual(ok.ignore, [{ check: 'meta', key: 'favicon' }]);
  assert.deepEqual(configWith({ sites: [{ url: 'https://a.test' }] }).ignore, []);
  assert.equal(configWith({ sites: [{ url: 'https://a.test' }] }).linkHostConcurrency, 2);
  assert.equal(configWith({ sites: [{ url: 'https://a.test' }] }).thresholds.marginPct, 10);
});

test('ignore: ignored critical issues do not fail --strict', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, r));
  const url = `http://localhost:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ign-strict-'));
  const cfg = path.join(dir, 'qa.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ sites: [{ url }], ignore: [{ check: 'pages', key: 'site-down', reason: 'staging is off' }] }));
  const cli = spawnSync(process.execPath, ['src/cli.js', '--config', cfg, '--no-email', '--no-ai', '--strict', '--out', dir], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'));
  assert.ok(!last.issues.some((i) => i.id.endsWith('|pages|site-down')));
});
