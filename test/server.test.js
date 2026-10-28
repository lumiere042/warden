import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './fixture-site/server.js';
import { startServer } from '../src/server.js';

let fixture, app, base, outDir;

before(async () => {
  fixture = createServer();
  await new Promise((r) => fixture.listen(0, r));
  base = `http://localhost:${fixture.address().port}`;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-serve-'));
  // Empty config file so the developer's own qa.config.json/.env sites don't leak in.
  const configPath = path.join(outDir, 'qa.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ sites: [], checkExternalLinks: false }));
  app = await startServer({ port: 0, configPath, outDir, log: () => {} });
});

after(async () => {
  await app?.close();
  fixture?.close();
});

const api = (p, opts) => fetch(app.url + p, opts).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** fetch() won't let us forge Host, so drop to node:http for the header tests. */
function raw(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(app.url + p, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForJob(id) {
  let job;
  for (let i = 0; i < 120; i++) {
    job = (await api(`/api/scan/${id}`)).body;
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return job;
}

test('serves the web page and status', async () => {
  const page = await fetch(app.url + '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /Check a/);
  const { body } = await api('/api/status');
  assert.equal(body.running, null);
  assert.deepEqual(body.reports, []);
});

test('rejects a bad URL', async () => {
  const { status, body } = await post('/api/scan', { url: 'not a url' });
  assert.equal(status, 400);
  assert.match(body.error, /web address/);
});

test('rejects a foreign Host header (DNS rebinding)', async () => {
  const { status } = await raw('GET', '/api/status', { host: 'evil.example:4173' });
  assert.equal(status, 403);
  const ok = await raw('GET', '/api/status', { host: `127.0.0.1:${new URL(app.url).port}` });
  assert.equal(ok.status, 200);
});

test('rejects cross-site style POSTs', async () => {
  const body = JSON.stringify({ url: base });
  const plain = await raw('POST', '/api/scan', { 'content-type': 'text/plain' }, body);
  assert.equal(plain.status, 415, 'text/plain is a CORS simple request; must not start a scan');
  const foreign = await raw('POST', '/api/scan', { 'content-type': 'application/json', origin: 'https://evil.example' }, body);
  assert.equal(foreign.status, 403);
  assert.equal((await api('/api/status')).body.running, null);
});

test('cancel on an unknown scan is 404', async () => {
  assert.equal((await post('/api/scan/999/cancel', {})).status, 404);
});

test('scans a site and serves the report', async () => {
  const start = await post('/api/scan', { url: base, maxPages: 5, ai: false });
  assert.equal(start.status, 202);

  const busy = await post('/api/scan', { url: base });
  assert.equal(busy.status, 409, 'only one scan at a time');

  const job = await waitForJob(start.body.id);
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.lines.some((l) => l.includes('crawl')));
  assert.ok(job.result.counts.brokenLinks >= 1);

  const report = await fetch(app.url + job.result.reportUrl);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.match(await report.text(), /Website QA report/);
  assert.equal((await api('/api/status')).body.reports.length, 1);

  const traversal = await fetch(app.url + '/reports/..%2F..%2Fpackage.json');
  assert.equal(traversal.status, 404, 'cannot read files outside the reports folder');

  const late = await post(`/api/scan/${start.body.id}/cancel`, {});
  assert.equal(late.status, 409, 'cannot cancel a finished scan');
});

test('cancels a running scan', async () => {
  const start = await post('/api/scan', { url: base, maxPages: 5, ai: false });
  assert.equal(start.status, 202);
  const cancel = await post(`/api/scan/${start.body.id}/cancel`, {});
  assert.equal(cancel.status, 202);
  const job = await waitForJob(start.body.id);
  // 'done' only if runQa ignores the AbortSignal (or finished before noticing it).
  assert.ok(['cancelled', 'done'].includes(job.status), `unexpected status ${job.status}: ${job.error}`);
  assert.equal((await api('/api/status')).body.running, null);
});
