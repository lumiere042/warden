import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from './fixture-site/server.js';
import { loadConfig } from '../src/config.js';
import { crawlSite } from '../src/crawler.js';
import { checkLinks } from '../src/checks/links.js';
import { checkMeta } from '../src/checks/meta.js';
import { checkPerformance } from '../src/checks/performance.js';
import { checkForms } from '../src/checks/forms.js';
import { buildReport } from '../src/report/build.js';
import { renderHtml } from '../src/report/html.js';

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
  assert.deepEqual([...new Set(paths(issues))], ['/slow']);
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

  // Analytics beacons fired on click are not the submission.
  for (const mode of ['intercept', 'submit']) {
    const broken = byKey[`form#tracked-broken|${mode}`];
    assert.equal(broken.passed, false, `broken form with analytics fails (${mode})`);
    assert.match(broken.reason, /no request to \/api\/signup was sent/);
    assert.match(broken.reason, /unrelated requests?: POST 127\.0\.0\.1:\d+\/(g\/collect|tr)/);
  }
  const tracked = byKey['form#tracked|intercept'];
  assert.equal(tracked.passed, true, tracked.reason);
  assert.equal(new URL(tracked.request.url).pathname, '/api/signup');
  assert.match(byKey['form#tracked|submit'].reason, /POST \/api\/signup returned 200/, 'third-party 404 beacon is ignored');
  assert.equal(byKey['form#tracked|submit'].passed, true);
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
