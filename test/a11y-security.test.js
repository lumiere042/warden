import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { crawlSite } from '../src/crawler.js';
import { CHECKS } from '../src/checks/index.js';
import accessibility, { checkAccessibility } from '../src/checks/accessibility.js';
import security, { checkSecurity, checkTransport, httpRedirectIssue, certIssue } from '../src/checks/security.js';

const page = (body, title = 'Fixture page') =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

// "/" sends no security headers; "/two" sends them all (CSP with frame-ancestors instead of X-Frame-Options).
const ROUTES = {
  '/': [200, {}, page('<img src="/pic.png"><p style="color:#bbb;background:#fff">Low contrast text</p><a href="/two">Two</a> <a href="/api">API</a>')],
  '/two': [
    200,
    { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
    page('<img src="/pic.png"><a href="/">Home</a>', 'Second page'),
  ],
  '/api': [200, { 'content-type': 'application/json' }, '{"ok":true}'],
  '/pic.png': [200, { 'content-type': 'image/png' }, ''],
  '/to-https': [301, { location: 'https://secure.example/' }, ''],
  '/hop': [302, { location: '/to-https' }, ''],
  '/loop': [302, { location: '/loop' }, ''],
};

let server, browser, base, config, pages;

before(async () => {
  server = http.createServer((req, res) => {
    const [status, headers, body] = ROUTES[new URL(req.url, 'http://x').pathname] || [404, {}, 'not found'];
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  config = loadConfig({ siteOverride: base });
  browser = await chromium.launch();
  pages = await crawlSite(browser, config.sites[0], config);
});

after(async () => {
  await browser?.close();
  server?.close();
});

const byPath = (p) => pages.find((x) => new URL(x.url).pathname === p);

test('checks are registered after meta', () => {
  assert.deepEqual(CHECKS.map((c) => c.name).slice(-3), ['meta', 'accessibility', 'security']);
  assert.deepEqual(config.accessibility.tags, ['wcag2a', 'wcag2aa']);
  assert.equal(config.security.certWarnDays, 21);
});

test('accessibility: axe violations grouped by rule across pages', () => {
  assert.equal(byPath('/api').isHtml, false);
  assert.equal(byPath('/api').data.accessibility, undefined, 'axe does not run on non-HTML pages');

  const { checked, issues } = checkAccessibility(pages, config);
  assert.equal(checked, 2);
  const alt = issues.find((i) => i.key === 'image-alt');
  assert.ok(alt, JSON.stringify(issues.map((i) => i.key)));
  assert.equal(alt.siteWide, true);
  assert.equal(alt.severity, 'critical', 'image-alt has critical impact');
  assert.equal(alt.detail.nodes, 2);
  assert.deepEqual(alt.detail.pages.map((u) => new URL(u).pathname).sort(), ['/', '/two']);
  assert.match(alt.detail.helpUrl, /^https:\/\/dequeuniversity\.com/);
  assert.match(alt.message, /^image-alt: .+ \(2 elements on 2 pages\)$/);

  const contrast = issues.find((i) => i.key === 'color-contrast');
  assert.ok(contrast);
  assert.equal(contrast.severity, 'warning', 'serious impact is a warning');
  assert.match(contrast.message, /\(1 element on 1 page\)/);
  assert.equal(issues.filter((i) => i.key === 'image-alt').length, 1, 'one issue per rule');
});

test('accessibility: disabled config collects and reports nothing; disableRules is honoured', async () => {
  const off = { ...config, accessibility: { enabled: false } };
  assert.deepEqual(checkAccessibility(pages, off), { checked: 0, issues: [] });
  assert.deepEqual(await accessibility.run({ pages, config: off }), { checked: 0, issues: [] });

  const offPages = await crawlSite(browser, { ...config.sites[0], maxPages: 1 }, off);
  assert.equal(offPages[0].data.accessibility, undefined);

  // A partial block keeps the other defaults (enabled, tags).
  const partial = { ...config, accessibility: { disableRules: ['color-contrast'] } };
  const some = await crawlSite(browser, { ...config.sites[0], maxPages: 1 }, partial);
  const keys = checkAccessibility(some, partial).issues.map((i) => i.key);
  assert.ok(keys.includes('image-alt'));
  assert.ok(!keys.includes('color-contrast'));
});

test('accessibility: a closed page or failed audit does not throw', async () => {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.close();
  const result = { url: base, finalUrl: base, isHtml: true, status: 200, data: {} };
  await accessibility.collect({ page: p, result, site: config.sites[0], config });
  assert.equal(result.data.accessibility, undefined);
  await context.close();

  const failed = [{ url: `${base}/x`, data: { accessibility: { error: 'Target page, context or browser has been closed' } } }];
  const { issues } = checkAccessibility(failed, config);
  assert.equal(issues[0].key, 'audit-failed');
  assert.equal(issues[0].severity, 'warning');
});

test('security: collect records headers per page; missing ones reported from the start page', async () => {
  const start = byPath('/').data.security;
  assert.equal(start.https, false);
  assert.deepEqual(Object.values(start.headers), [false, false, false, false, false]);
  assert.deepEqual(byPath('/two').data.security.headers, {
    'strict-transport-security': false,
    'content-security-policy': true,
    'x-content-type-options': true,
    'x-frame-options': true,
    'referrer-policy': true,
  });

  const { issues } = await security.run({ pages, site: config.sites[0], config });
  const keys = issues.map((i) => i.key).sort();
  assert.deepEqual(keys, ['header:content-security-policy', 'header:referrer-policy', 'header:x-content-type-options', 'header:x-frame-options'], 'no HSTS on http, no https issues for localhost');
  const csp = issues.find((i) => i.key === 'header:content-security-policy');
  assert.equal(csp.siteWide, true);
  assert.equal(csp.severity, 'warning');
  assert.deepEqual(csp.detail.pages, [byPath('/').url]);
  assert.match(csp.message, /Missing Content-Security-Policy header on 1 of 2 pages/);

  const quiet = { ...config, security: { headers: false } };
  assert.deepEqual((await security.run({ pages, site: config.sites[0], config: quiet })).issues, []);
  assert.deepEqual(await security.run({ pages, site: config.sites[0], config: { ...config, security: { enabled: false } } }), { checked: 0, issues: [] });
});

test('security: mixed content found on an https page in the browser', async () => {
  const context = await browser.newContext();
  // Only the page itself is served; every subresource (including Chrome's https upgrades) is aborted.
  await context.route('**/*', (route) =>
    route.request().url() !== 'https://secure.example/' ? route.abort() : route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'strict-transport-security': 'max-age=31536000' },
      body: page(
        '<img src="http://insecure.example/a.png"><script src="http://insecure.example/b.js"></script>' +
          '<img srcset="http://insecure.example/c.png 2x, /ok.png 1x"><img src="https://secure.example/fine.png"><a href="http://insecure.example/link">a link is fine</a>'
      ),
    })
  );
  const p = await context.newPage();
  const response = await p.goto('https://secure.example/');
  const result = { url: 'https://secure.example/', finalUrl: p.url(), isHtml: true, status: 200, data: {} };
  await security.collect({ page: p, response, result, site: { url: 'https://secure.example' }, config });
  await context.close();

  const s = result.data.security;
  assert.equal(s.https, true);
  assert.equal(s.headers['strict-transport-security'], true);
  assert.deepEqual(s.mixedContent.sort(), ['http://insecure.example/a.png', 'http://insecure.example/b.js', 'http://insecure.example/c.png']);
});

test('security: mixed content and HSTS rules on synthetic https pages', () => {
  const site = { url: 'https://shop.example' };
  const all = { 'strict-transport-security': true, 'content-security-policy': true, 'x-content-type-options': true, 'x-frame-options': true, 'referrer-policy': true };
  const mk = (path, source, headers, mixedContent = []) => ({
    url: `https://shop.example${path}`,
    source,
    status: 200,
    data: { security: { https: true, headers: { ...all, ...headers }, mixedContent } },
  });
  const urls = ['http://cdn.example/1.js', 'http://cdn.example/2.css', 'http://cdn.example/3.png', 'http://cdn.example/4.png', 'http://cdn.example/5.png'];
  const pages = [
    mk('/', 'start', { 'strict-transport-security': false }),
    mk('/a', 'link', { 'strict-transport-security': false, 'referrer-policy': false }, urls),
    mk('/b', 'link', {}, ['http://cdn.example/1.js']),
  ];
  const { checked, issues } = checkSecurity(pages, site, config);
  assert.equal(checked, 3);

  const hsts = issues.find((i) => i.key === 'header:strict-transport-security');
  assert.deepEqual(hsts.detail.pages, ['https://shop.example/', 'https://shop.example/a']);
  assert.match(hsts.message, /on 2 of 3 pages/);
  assert.ok(!issues.some((i) => i.key === 'header:referrer-policy'), 'only judged on the start page, which has it');

  const mixed = issues.filter((i) => i.key === 'mixed-content');
  assert.deepEqual(mixed.map((i) => i.page), ['https://shop.example/a', 'https://shop.example/b']);
  assert.ok(mixed.every((i) => i.severity === 'critical' && !i.siteWide));
  assert.match(mixed[0].message, /^Mixed content: 5 resources .*http:\/\/cdn\.example\/1\.js, http:\/\/cdn\.example\/2\.css, http:\/\/cdn\.example\/3\.png \(\+2 more\)$/);
  assert.match(mixed[1].message, /1 resource loaded/);
});

test('security: http-only site is a warning, except on localhost', async () => {
  const [warn] = await checkTransport({ url: 'http://shop.example' }, [], config);
  assert.equal(warn.key, 'no-https');
  assert.equal(warn.severity, 'warning');
  assert.match(warn.message, /not served over HTTPS/);
  assert.deepEqual(await checkTransport({ url: 'http://127.0.0.1:8080' }, [], config), []);
  assert.deepEqual(await checkTransport({ url: 'http://localhost:3000' }, [], config), []);
});

test('security: http -> https redirect follows hops manually', async () => {
  assert.equal(await httpRedirectIssue(`${base}/to-https`, config), null);
  assert.equal(await httpRedirectIssue(`${base}/hop`, config), null, 'two hops still end on https');

  const plain = await httpRedirectIssue(`${base}/two`, config);
  assert.match(plain.message, /serves the site over plain http/);
  assert.equal(plain.detail.status, 200);

  assert.match((await httpRedirectIssue(`${base}/nope`, config)).message, /does not redirect to https:\/\/ \(returns 404\)/);
  assert.match((await httpRedirectIssue(`${base}/loop`, config)).message, /more than 5 redirects/);

  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  assert.match((await httpRedirectIssue(`http://localhost:${port}/`, config)).message, /does not respond \(ECONNREFUSED\)/);
});

test('security: certificate decision logic', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const ok = { authorized: true, authorizationError: null };
  assert.equal(certIssue({ ...ok, validTo: 'Mar 15 12:00:00 2027 GMT' }, now, 21), null);

  const soon = certIssue({ ...ok, validTo: 'Nov 07 12:00:00 2026 GMT' }, now, 21);
  assert.deepEqual([soon.severity, soon.key], ['warning', 'cert-expiring']);
  assert.match(soon.message, /expires in 10 days \(2026-11-07\)/);
  assert.equal(certIssue({ ...ok, validTo: 'Nov 07 12:00:00 2026 GMT' }, now, 7), null, 'outside a shorter warning window');

  const expired = certIssue({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED', validTo: 'Oct 01 00:00:00 2026 GMT' }, now, 21);
  assert.deepEqual([expired.severity, expired.key], ['critical', 'cert-expired']);
  assert.match(expired.message, /expired on 2026-10-01/);

  const untrusted = certIssue({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', validTo: 'Mar 15 12:00:00 2027 GMT' }, now, 21);
  assert.deepEqual([untrusted.severity, untrusted.key], ['critical', 'cert-invalid']);
  assert.match(untrusted.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
});
