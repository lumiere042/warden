import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('serves the web page and status', async () => {
  const page = await fetch(app.url + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Check a/);
  const { body } = await api('/api/status');
  assert.equal(body.running, null);
  assert.deepEqual(body.reports, []);
});

test('rejects a bad URL', async () => {
  const { status, body } = await api('/api/scan', { method: 'POST', body: JSON.stringify({ url: 'not a url' }) });
  assert.equal(status, 400);
  assert.match(body.error, /web address/);
});

test('scans a site and serves the report', async () => {
  const start = await api('/api/scan', { method: 'POST', body: JSON.stringify({ url: base, maxPages: 5, ai: false }) });
  assert.equal(start.status, 202);

  const busy = await api('/api/scan', { method: 'POST', body: JSON.stringify({ url: base }) });
  assert.equal(busy.status, 409, 'only one scan at a time');

  let job;
  for (let i = 0; i < 120; i++) {
    job = (await api(`/api/scan/${start.body.id}`)).body;
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(job.status, 'done', job.error);
  assert.ok(job.lines.some((l) => l.includes('crawl')));
  assert.ok(job.result.counts.brokenLinks >= 1);

  const report = await fetch(app.url + job.result.reportUrl);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /Website QA report/);
  assert.equal((await api('/api/status')).body.reports.length, 1);

  const traversal = await fetch(app.url + '/reports/..%2F..%2Fpackage.json');
  assert.equal(traversal.status, 404, 'cannot read files outside the reports folder');
});
