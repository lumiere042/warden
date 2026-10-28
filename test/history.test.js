import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { readHistory } from '../src/report/history.js';

let app, outDir;

const site = (url, extra = {}) => ({ url, pagesCrawled: 4, issues: [], fixed: [], counts: { critical: 1, warning: 2, new: 0 }, ...extra });
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), typeof data === 'string' ? data : JSON.stringify(data));

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-'));
  // Old format: no byCheck, no avgCls, no checks.
  write('2026-01-01_1000_example.com.json', {
    generatedAt: '2026-01-01T10:00:00.000Z',
    sites: [site('https://example.com', { counts: { critical: 3, warning: 4, new: 0 }, performance: { avgLoadMs: 1200, avgLcpMs: 900 } })],
  });
  write('2026-01-15_1000_example.com.json', '{ not json');
  write('2026-01-20_1000_example.com.json', { generatedAt: 'yesterday', sites: [] });
  // New format.
  write('2026-02-01_1000_example.com.json', {
    generatedAt: '2026-02-01T10:00:00.000Z',
    sites: [site('https://example.com', {
      fixed: [{ id: 'a' }, { id: 'b' }],
      counts: { critical: 1, warning: 5, new: 2, byCheck: { links: { critical: 1, warning: 0 } } },
      checks: { performance: { title: 'Speed', summary: { avgLoadMs: 800, avgLcpMs: 700, avgCls: 0.05 } } },
      performance: { avgLoadMs: 800, avgLcpMs: 700, avgCls: 0.05 },
    })],
  });
  write('2026-03-01_0900_example.com+other.org.json', {
    generatedAt: '2026-03-01T09:00:00.000Z',
    sites: [site('https://example.com'), site('https://other.org', { counts: { critical: 0, warning: 1, new: 1 } })],
  });
  write('2026-04-01_0900_example.com.json', { generatedAt: '2026-04-01T09:00:00.000Z', sites: [site('https://example.com', { counts: {} })] });
  write('last.json', { generatedAt: '2026-05-01T09:00:00.000Z', issues: [] });
  write('2026-04-01_0900_example.com.html', '<html></html>');
  app = await startServer({ port: 0, outDir, configPath: path.join(outDir, 'none.json'), log: () => {} });
});

after(async () => {
  await app?.close();
});

const api = (p) => fetch(app.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));

test('lists every site with run counts, latest first', async () => {
  const { status, body } = await api('/api/history');
  assert.equal(status, 200);
  assert.deepEqual(body.sites.map((s) => [s.site, s.runs]), [['example.com', 4], ['other.org', 1]]);
  assert.equal(body.sites[0].latest.generatedAt, '2026-04-01T09:00:00.000Z');
  assert.equal(body.sites[1].latest.reportUrl, `/reports/${encodeURIComponent('2026-03-01_0900_example.com+other.org')}.html`);
});

test('one site: runs oldest first, tolerant of old and malformed reports', async () => {
  const { body } = await api(`/api/history?site=${encodeURIComponent('https://example.com')}`);
  assert.equal(body.site, 'example.com');
  assert.deepEqual(body.runs.map((r) => r.generatedAt.slice(0, 10)), ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  const [old, recent, multi, empty] = body.runs;
  assert.equal(old.critical, 3);
  assert.equal(old.byCheck, null);
  assert.equal(old.avgCls, null);
  assert.equal(old.avgLoadMs, 1200);
  assert.equal(recent.fixed, 2);
  assert.equal(recent.new, 2);
  assert.deepEqual(recent.byCheck, { links: { critical: 1, warning: 0 } });
  assert.equal(recent.avgCls, 0.05);
  assert.equal(multi.pagesCrawled, 4);
  assert.equal(empty.critical, null, 'missing counts come back as null');

  const byHost = await api('/api/history?site=example.com');
  assert.deepEqual(byHost.body, body, 'a host works as well as an origin');
  const other = await api('/api/history?site=other.org');
  assert.deepEqual(other.body.runs.map((r) => r.warning), [1]);
  assert.deepEqual((await api('/api/history?site=nowhere.net')).body.runs, []);

  const report = await fetch(app.url + empty.reportUrl);
  assert.equal(report.status, 200, 'report links point at the saved files');
});

test('caps a site at its latest 200 runs, and copes with a missing folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-history-cap-'));
  for (let i = 0; i < 205; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const name = `${at.slice(0, 16).replace('T', '_').replace(':', '')}_example.com.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ generatedAt: at, sites: [site('https://example.com')] }));
  }
  const { runs } = readHistory(dir, 'example.com');
  assert.equal(runs.length, 200);
  assert.equal(runs.at(-1).generatedAt, new Date(Date.UTC(2026, 0, 1, 0, 204)).toISOString());
  assert.deepEqual(readHistory(path.join(dir, 'missing'), null), { sites: [] });
});
