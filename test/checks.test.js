import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from './fixture-site/server.js';
import { loadConfig } from '../src/config.js';
import { crawlSite } from '../src/crawler.js';
import { checkLinks } from '../src/checks/links.js';
import { checkMeta } from '../src/checks/meta.js';
import { checkPerformance } from '../src/checks/performance.js';
import { checkForms } from '../src/checks/forms.js';
import { checkPages } from '../src/checks/pages.js';
import { CHECKS } from '../src/checks/index.js';
import { buildReport, subjectLine } from '../src/report/build.js';
import { renderHtml } from '../src/report/html.js';
import { runQa } from '../src/run.js';
import { contextOptions, authHeaders } from '../src/browser.js';

let server, browser, site, config, pages;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  // Point the fixture config at whichever port we got.
  const raw = JSON.parse(fs.readFileSync(new URL('./fixture-site/qa.config.json', import.meta.url), 'utf8'));
  raw.sites[0].url = base;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-')), 'qa.config.json');
  fs.writeFileSync(tmp, JSON.stringify(raw));
  config = loadConfig({ configPath: tmp });
  site = config.sites[0];

  browser = await chromium.launch();
  pages = await crawlSite(browser, site, config);
});

after(async () => {
  await browser?.close();
  server?.close();
});

const paths = (issues) => issues.map((i) => new URL(i.page).pathname);

test('crawl follows links and reads sitemap.xml', () => {
  const crawled = pages.map((p) => new URL(p.url).pathname).sort();
  assert.ok(crawled.includes('/about'));
  assert.ok(crawled.includes('/hidden'), 'sitemap-only page should be crawled');
  assert.ok(crawled.includes('/from-robots'), 'robots.txt Sitemap line -> sitemap index -> .xml.gz is read');
  assert.ok(!crawled.includes('/brochure.pdf'), 'PDF in the sitemap is not crawled as a page');
  assert.ok(!crawled.includes('/only-from-404'), 'links on a 404 page are not followed');
  assert.equal(new Set(pages.map((p) => p.url)).size, pages.length, 'no page crawled twice');
  const source = (p) => pages.find((x) => new URL(x.url).pathname === p).source;
  assert.equal(pages[0].source, 'start');
  assert.equal(source('/about'), 'link');
  assert.equal(source('/hidden'), 'sitemap');
});

test('maxPages is exact and the start page comes first', async () => {
  const few = await crawlSite(browser, { ...site, maxPages: 4 }, config);
  assert.equal(few.length, 4);
  assert.equal(new URL(few[0].url).pathname, '/');
  // Links and sitemap URLs take turns after the start page.
  assert.deepEqual(few.slice(1, 3).map((p) => p.source).sort(), ['link', 'sitemap']);
});

test('pages check: sitemap-only 404 reported, linked 404 left to the links check', () => {
  const { issues } = checkPages(pages);
  const gone = issues.find((i) => i.page.endsWith('/gone-from-sitemap'));
  assert.ok(gone, 'sitemap-only 404 is reported');
  assert.equal(gone.severity, 'warning');
  assert.match(gone.message, /Listed in sitemap\.xml but returns 404/);
  assert.ok(!issues.some((i) => i.page.endsWith('/missing-page') && i.key === 'broken'), 'linked 404 is not double reported');
  assert.ok(!issues.some((i) => i.key === 'site-down'));
});

test('pages check: JavaScript errors grouped across pages', () => {
  const js = checkPages(pages).issues.filter((i) => i.key.startsWith('js-error:'));
  const widget = js.find((i) => i.message.includes('Widget failed'));
  assert.ok(widget, 'console.error is reported');
  assert.equal(widget.siteWide, true);
  assert.deepEqual(widget.detail.pages.map((p) => new URL(p).pathname).sort(), ['/hidden', '/js-error'], 'same error with different ?v= and line numbers is one issue');
  assert.match(widget.message, /^JavaScript error on 2 pages: /);
  assert.ok(js.some((i) => i.message.includes('Boom from fixture')), 'uncaught exception is reported');
  assert.ok(!js.some((i) => /Failed to load resource/.test(i.message)), 'resource load failures are left to the links check');
});

test('pages check: site down is critical', () => {
  const down = checkPages([{ url: 'http://x.test/', source: 'start', status: 503, error: null, links: [], consoleErrors: [] }]);
  assert.equal(down.issues[0].key, 'site-down');
  assert.equal(down.issues[0].severity, 'critical');
  assert.equal(down.issues[0].message, 'Home page returns 503');
});

test('finds broken internal link and missing image', async () => {
  const { issues } = await checkLinks(pages, site, config);
  const urls = issues.map((i) => new URL(i.detail.url).pathname);
  assert.ok(urls.includes('/missing-page'));
  assert.ok(urls.includes('/img/missing.png'));
  assert.ok(!urls.includes('/logo.png'), 'working image is not reported');
});

test('finds meta problems', () => {
  const { issues } = checkMeta(pages);
  const about = issues.filter((i) => i.page.endsWith('/about')).map((i) => i.key);
  assert.ok(about.includes('description-missing'));
  assert.ok(about.includes('h1-multiple'));
  assert.ok(about.includes('open-graph'));
  assert.ok(issues.some((i) => i.key === 'noindex' && i.page.endsWith('/noindex')));
  assert.ok(!paths(issues).includes('/'), 'home page has complete meta');
});

test('flags the slow page only', () => {
  const { issues } = checkPerformance(pages, config);
  assert.deepEqual([...new Set(paths(issues.filter((i) => i.key !== 'cls')))], ['/slow']);
});

test('measures layout shift (CLS)', () => {
  const shifty = pages.find((p) => p.url.endsWith('/layout-shift'));
  assert.ok(shifty.perf.cls > 0.1, `CLS measured: ${shifty.perf.cls}`);
  const { issues, summary } = checkPerformance(pages, config);
  assert.deepEqual(paths(issues.filter((i) => i.key === 'cls')), ['/layout-shift']);
  assert.match(issues.find((i) => i.key === 'cls').message, /^Layout shift \(CLS\) \d\.\d\d \(limit 0\.10\)$/);
  assert.ok(summary.avgCls > 0);
});

test('form tests: intercept, real submit, server error, validation', async () => {
  const { results, untested } = await checkForms(browser, pages, site, config);
  const byKey = Object.fromEntries(results.map((r) => [`${r.selector}|${r.mode}`, r]));
  assert.equal(byKey['form#contact|intercept'].passed, true);
  assert.equal(byKey['form#contact|submit'].passed, true);
  assert.equal(byKey['form#broken|submit'].passed, false);
  assert.match(byKey['form#broken|submit'].reason, /500/);
  assert.equal(byKey['form#required|intercept'].passed, false);
  assert.match(byKey['form#required|intercept'].reason, /validation/);
  assert.ok(untested.some((f) => f.action.endsWith('/api/newsletter')), 'unconfigured newsletter form is listed');
  assert.ok(!untested.some((f) => f.id === 'contact'), 'configured form is not listed as untested');
});

test('report marks new and fixed issues against the previous run', async () => {
  const result = {
    site,
    pages,
    links: await checkLinks(pages, site, config),
    forms: { issues: [], results: [], untested: [] },
    meta: checkMeta(pages),
    performance: checkPerformance(pages, config),
  };
  const first = buildReport([result], null);
  const firstIds = first.sites[0].issues.map((i) => i.id);
  const previous = {
    issues: [
      ...first.sites[0].issues.slice(1).map(({ id, message }) => ({ id, message })),
      { id: `${site.url}|links|${site.url}/|gone`, message: 'old broken link', page: `${site.url}/` },
    ],
  };
  const second = buildReport([result], previous);
  assert.equal(second.sites[0].issues.find((i) => i.id === firstIds[0]).isNew, true);
  assert.equal(second.sites[0].counts.new, 1);
  assert.deepEqual(second.sites[0].fixed.map((f) => f.message), ['old broken link']);

  const html = renderHtml(second, { text: 'All good\n- fix <this>', provider: 'p', model: 'm' });
  assert.ok(html.includes('fix &lt;this&gt;'), 'AI text is escaped');
  assert.ok(html.includes('Fixed since last run'));
});

test('report: every check in CHECKS, generic sections, per-check counts', async () => {
  const checks = {};
  for (const check of CHECKS) checks[check.name] = await check.run({ browser, pages, site, config, previous: null, log: () => {} });
  const report = buildReport([{ site, pages, checks }], null);
  const s = report.sites[0];
  assert.deepEqual(Object.keys(s.checks), CHECKS.map((c) => c.name));
  assert.equal(s.checks.pages.title, 'Pages');
  assert.equal(s.counts.byCheck.pages.warning, s.issues.filter((i) => i.check === 'pages' && i.severity === 'warning').length);
  assert.ok(s.formResults.length && s.untestedForms.length, 'backward-compatible form fields kept');
  const html = renderHtml(report, null);
  assert.ok(html.indexOf('>Pages <') < html.indexOf('>Broken links <'), 'sections follow CHECKS order');
  assert.match(html, /JavaScript error on 2 pages/);
  assert.match(subjectLine(report), /broken link/);
});

test('site-wide issue ids do not depend on which page found them first', () => {
  const s = { url: 'https://a.test' };
  const link = (page) => ({ check: 'links', severity: 'critical', key: 'https://a.test/x', siteWide: true, page, message: 'Broken a (404)' });
  const run = (issue) => ({ site: s, pages: [], checks: { links: { checked: 1, issues: [issue] } } });
  const first = buildReport([run(link('https://a.test/one'))], null);
  const second = buildReport([run(link('https://a.test/two'))], { issues: first.sites[0].issues });
  assert.equal(second.sites[0].issues[0].isNew, false);
  assert.deepEqual(second.sites[0].fixed, []);

  // A last.json written before site-wide ids still matches (no spurious NEW + FIXED pair).
  const legacy = { issues: [{ id: 'https://a.test|links|https://a.test/two|https://a.test/x', message: 'Broken a (404)' }] };
  const third = buildReport([run(link('https://a.test/two'))], legacy);
  assert.equal(third.sites[0].issues[0].isNew, false);
  assert.deepEqual(third.sites[0].fixed, []);
});

test('site down: critical, not "all clear", --strict exits 1', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, r));
  const url = `http://localhost:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-down-'));

  const { report, subject } = await runQa(loadConfig({ siteOverride: url }), { outDir, ai: false });
  assert.equal(report.sites[0].issues[0].key, 'site-down');
  assert.ok(report.sites[0].counts.critical >= 1);
  assert.doesNotMatch(subject, /all clear/);
  assert.match(subject, /site unreachable/);

  const cli = spawnSync(process.execPath, ['src/cli.js', url, '--no-email', '--no-ai', '--strict', '--out', outDir], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
});

test('browser context factory: device, auth headers, basic auth from env', () => {
  const saved = { ...process.env };
  try {
    const mobile = contextOptions({ ...config, device: 'Pixel 7' });
    assert.equal(mobile.isMobile, true);
    assert.ok(mobile.userAgent.includes('warden-qa-bot'), 'still identifies as the bot');
    assert.throws(() => contextOptions({ ...config, device: 'Nokia 3310' }), /Unknown device/);

    process.env.AUTH_USERNAME = 'qa';
    process.env.AUTH_PASSWORD = 'secret';
    process.env.QA_TOKEN = 'tok';
    const authed = { ...config, auth: { headers: { 'x-token': 'Bearer ${QA_TOKEN}' } } };
    const opts = contextOptions(authed);
    assert.deepEqual(opts.httpCredentials, { username: 'qa', password: 'secret' });
    assert.equal(opts.extraHTTPHeaders['x-token'], 'Bearer tok');
    assert.equal(authHeaders(authed, `${site.url}/x.png`).authorization, `Basic ${Buffer.from('qa:secret').toString('base64')}`);
    assert.deepEqual(authHeaders(authed, 'https://external.example/x'), {}, 'credentials never sent to other sites');
  } finally {
    process.env = saved;
  }
});

test('aborting the signal stops the scan with "Scan cancelled"', async () => {
  const controller = new AbortController();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cancel-'));
  const log = (line) => {
    if (line.includes('crawl 2/')) controller.abort();
  };
  await assert.rejects(runQa(config, { outDir, ai: false, log, signal: controller.signal }), /Scan cancelled/);
  assert.ok(!fs.existsSync(path.join(outDir, 'last.json')), 'no report written');
});
