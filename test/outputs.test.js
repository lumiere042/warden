import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toSarif, toJunit, toMarkdown, parseFormats, writeFormats, writeJobSummary } from '../src/report/formats.js';
import { sendNotifications, reportLink } from '../src/notify/webhooks.js';
import { loadConfig } from '../src/config.js';
import { runQa } from '../src/run.js';
import { createServer } from './fixture-site/server.js';

const ENV_KEYS = ['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'WEBHOOK_URL', 'REPORT_URL_BASE', 'GITHUB_STEP_SUMMARY', 'GITHUB_RUN_ID', 'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clearEnv = () => ENV_KEYS.forEach((k) => delete process.env[k]);

const site = 'https://example.com';
const issue = (over) => ({ check: 'links', severity: 'critical', key: `${site}/x`, page: `${site}/`, message: 'Broken a (404)', detail: { url: `${site}/x` }, isNew: false, ...over });
const makeReport = (issues, { fixed = [], ai = null } = {}) => ({
  generatedAt: '2026-10-28T15:43:00.000Z',
  sites: [
    {
      url: site,
      pagesCrawled: 4,
      issues: issues.map((i) => ({ ...i, id: `${site}|${i.check}|${i.page}|${i.key}` })),
      fixed,
      checks: { links: { title: 'Links', checked: 10 }, meta: { title: 'SEO', checked: 4 } },
      counts: {
        critical: issues.filter((i) => i.severity === 'critical').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        new: issues.filter((i) => i.isNew).length,
      },
    },
  ],
  ai,
});

const report = makeReport(
  [
    issue({ isNew: true }),
    issue({ key: 'bad', message: 'Title has <&"> chars', detail: undefined }),
    issue({ check: 'meta', severity: 'warning', key: 'title-missing', page: `${site}/about`, message: 'Missing <title>', detail: undefined }),
  ],
  { fixed: [{ id: 'old' }], ai: { text: 'Fix the 404s first.', provider: 'x', model: 'y' } }
);

// ---------- webhook capture server ----------

let hook, hookUrl;
const received = [];
before(async () => {
  clearEnv();
  hook = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
    if (req.url === '/fail') {
      res.writeHead(500);
      return res.end('nope');
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, r));
  hookUrl = `http://localhost:${hook.address().port}`;
});

after(() => {
  hook?.close();
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const pointHooks = () => {
  process.env.SLACK_WEBHOOK_URL = `${hookUrl}/slack`;
  process.env.DISCORD_WEBHOOK_URL = `${hookUrl}/discord`;
  process.env.TEAMS_WEBHOOK_URL = `${hookUrl}/teams`;
  process.env.WEBHOOK_URL = `${hookUrl}/hook`;
};
const take = () => Object.fromEntries(received.splice(0).map((r) => [r.path.slice(1), r.body]));

// ---------- CI formats ----------

test('SARIF: valid 2.1.0 structure, levels, rules and fingerprints', () => {
  const sarif = JSON.parse(JSON.stringify(toSarif(report)));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'Warden');
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ['links', 'meta']);
  assert.deepEqual(run.results.map((r) => r.level), ['error', 'error', 'warning']);
  assert.equal(run.results[0].ruleId, 'links');
  assert.equal(run.results[0].ruleIndex, 0);
  assert.equal(run.results[2].ruleIndex, 1);
  assert.match(run.results[0].message.text, /Broken a \(404\): https:\/\/example\.com\/x/);
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, `${site}/`);
  const fps = run.results.map((r) => r.partialFingerprints['wardenIssue/v1']);
  assert.equal(new Set(fps).size, 3);
  assert.equal(toSarif(report).runs[0].results[0].partialFingerprints['wardenIssue/v1'], fps[0], 'stable across runs');
});

test('JUnit: well-formed, escaped, one suite per check, counts', () => {
  const xml = toJunit(report);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<testsuites name="Warden" tests="3" failures="2" errors="0">/);
  assert.match(xml, /<testsuite name="example.com: Links" tests="2" failures="2"/);
  assert.match(xml, /<testsuite name="example.com: SEO" tests="1" failures="0"/);
  assert.match(xml, /Title has &lt;&amp;&quot;&gt; chars/);
  assert.ok(!xml.includes('<&">'), 'raw special characters never reach the XML');
  assert.match(xml, /<system-out>warning: Missing &lt;title&gt;/);
  // Tags balance (a cheap well-formedness check without an XML parser).
  const tags = [...xml.matchAll(/<(\/?)(testsuites|testsuite|testcase|failure|system-out)\b[^>]*?(\/?)>/g)];
  const stack = [];
  for (const [, close, name, self] of tags) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.equal(stack.length, 0);

  const clean = toJunit(makeReport([]));
  assert.match(clean, /<testcase classname="example.com.links" name="no issues"\/>/);
  assert.match(clean, /tests="2" failures="0"/);
});

test('Markdown: counts table, critical list, new/fixed, AI summary', () => {
  const md = toMarkdown(report, { subject: 'QA example.com — 2 broken links', reportName: 'r.html' });
  assert.match(md, /^## QA example.com — 2 broken links/);
  assert.match(md, /4 pages crawled · \*\*2 critical\*\* · 1 warning · 1 new · 1 fixed/);
  assert.match(md, /\| Links \| 2 \| 0 \|/);
  assert.match(md, /\| SEO \| 0 \| 1 \|/);
  assert.match(md, /\| \*\*Total\*\* \| \*\*2\*\* \| \*\*1\*\* \|/);
  assert.match(md, /- `\/` Broken a \(404\): https:\/\/example\.com\/x _\(new\)_/);
  assert.match(md, /Title has &lt;&"&gt; chars/);
  assert.match(md, /### AI summary\n\nFix the 404s first\./);
  assert.match(md, /Full report: `r.html`/);
});

test('parseFormats validates and writeFormats writes next to the report', () => {
  assert.deepEqual(parseFormats('sarif, JUnit,md'), ['sarif', 'junit', 'markdown']);
  assert.deepEqual(parseFormats(undefined), []);
  assert.throws(() => parseFormats('sarif,pdf'), /Unknown format "pdf"/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fmt-'));
  const files = writeFormats(path.join(dir, 'run1'), report, ['sarif', 'junit', 'markdown']);
  assert.deepEqual(files.map((f) => path.basename(f)), ['run1.sarif', 'run1.junit.xml', 'run1.md']);
  assert.equal(JSON.parse(fs.readFileSync(files[0], 'utf8')).version, '2.1.0');
});

test('job summary is appended only when GITHUB_STEP_SUMMARY is set', () => {
  assert.equal(writeJobSummary(report), false);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sum-')), 'summary.md');
  fs.writeFileSync(file, 'previous step\n');
  process.env.GITHUB_STEP_SUMMARY = file;
  try {
    assert.equal(writeJobSummary(report, { subject: 'QA subject' }), true);
  } finally {
    delete process.env.GITHUB_STEP_SUMMARY;
  }
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^previous step\n## QA subject/);
  assert.match(text, /\*\*2 critical\*\*/);
});

// ---------- webhooks ----------

test('webhooks: payload shapes for slack, discord, teams and generic JSON', async () => {
  pointHooks();
  process.env.REPORT_URL_BASE = 'https://qa.example.com/reports/';
  const logs = [];
  try {
    const sent = await sendNotifications(report, { subject: 'QA example.com — 2 broken links', reportName: 'run 1.html', log: (m) => logs.push(m) });
    assert.deepEqual(sent, ['slack', 'discord', 'teams', 'webhook']);
  } finally {
    clearEnv();
  }
  const got = take();

  assert.equal(got.slack.text, 'QA example.com — 2 broken links');
  assert.equal(got.slack.blocks[0].type, 'header');
  const slackText = got.slack.blocks[1].text.text;
  assert.match(slackText, /\*example.com\*: 2 critical, 1 warning, 1 new, 1 fixed/);
  assert.match(slackText, /• \/ — Title has &lt;&amp;"&gt; chars/);
  assert.match(slackText, /<https:\/\/qa\.example\.com\/reports\/run%201\.html\|Open the report>/);
  assert.match(got.slack.blocks[2].text.text, /Fix the 404s first/);

  assert.match(got.discord.content, /^\*\*QA example.com — 2 broken links\*\*/);
  assert.match(got.discord.content, /AI summary\*\*\nFix the 404s first\./);
  assert.deepEqual(got.discord.allowed_mentions, { parse: [] });

  assert.equal(got.teams.type, 'message');
  const card = got.teams.attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.content.type, 'AdaptiveCard');
  assert.match(card.content.body.map((b) => b.text).join('\n'), /2 critical, 1 warning/);
  assert.equal(card.content.actions[0].url, 'https://qa.example.com/reports/run%201.html');

  assert.equal(got.hook.subject, 'QA example.com — 2 broken links');
  assert.deepEqual(got.hook.sites, [{ url: site, pagesCrawled: 4, critical: 2, warning: 1, new: 1, fixed: 1 }]);
  assert.deepEqual(got.hook.totals, { critical: 2, warning: 1, new: 1, fixed: 1 });
  assert.equal(got.hook.critical.length, 2);
  assert.equal(got.hook.report, 'run 1.html');
  assert.equal(got.hook.ai, 'Fix the 404s first.');
  assert.ok(logs.includes('Notified slack'));
});

test('webhooks: long content is truncated to platform limits; top 5 / top 10 issues', async () => {
  const many = Array.from({ length: 30 }, (_, n) => issue({ key: `k${n}`, page: `${site}/p${n}`, message: `Broken ${'x'.repeat(200)} ${n}` }));
  const big = makeReport(many, { ai: { text: 'A'.repeat(10000) } });
  pointHooks();
  try {
    await sendNotifications(big, { subject: 'S'.repeat(400), reportName: 'r.html' });
  } finally {
    clearEnv();
  }
  const got = take();
  for (const b of got.slack.blocks.slice(1)) assert.ok(b.text.text.length <= 3000);
  assert.ok(got.slack.blocks[0].text.text.length <= 150);
  assert.ok(got.slack.blocks[2].text.text.endsWith('…'));
  assert.equal((got.slack.blocks[1].text.text.match(/^• /gm) || []).length, 5);
  assert.match(got.slack.blocks[1].text.text, /…and 25 more/);
  assert.ok(got.discord.content.length <= 2000);
  for (const b of got.teams.attachments[0].content.body) assert.ok(b.text.length <= 4000);
  assert.equal(got.hook.critical.length, 10);
  assert.equal(got.hook.ai.length, 10000, 'generic JSON keeps the full AI text');
});

test('webhooks: onlyOnIssues skips a clean run; nothing configured sends nothing', async () => {
  assert.deepEqual(await sendNotifications(report, { subject: 's' }), [], 'no URLs set');
  pointHooks();
  const logs = [];
  try {
    const clean = makeReport([issue({ severity: 'warning' })]);
    assert.deepEqual(await sendNotifications(clean, { subject: 's', onlyOnIssues: true, log: (m) => logs.push(m) }), []);
    assert.match(logs[0], /skipped/);
    const fresh = makeReport([issue({ severity: 'warning', isNew: true })]);
    assert.equal((await sendNotifications(fresh, { subject: 's', onlyOnIssues: true })).length, 4, 'new warnings still notify');
  } finally {
    clearEnv();
  }
  take();
});

test('webhooks: a failing webhook is logged, not thrown', async () => {
  process.env.SLACK_WEBHOOK_URL = `${hookUrl}/fail`;
  process.env.DISCORD_WEBHOOK_URL = 'http://127.0.0.1:1/unreachable';
  process.env.WEBHOOK_URL = `${hookUrl}/hook`;
  const logs = [];
  try {
    const sent = await sendNotifications(report, { subject: 's', log: (m) => logs.push(m) });
    assert.deepEqual(sent, ['webhook']);
  } finally {
    clearEnv();
  }
  assert.ok(logs.some((l) => /^Webhook to slack failed: HTTP 500 nope$/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l.startsWith('Webhook to discord failed: ')));
  take();
});

test('report link: REPORT_URL_BASE, {file} placeholder, GitHub run page', () => {
  assert.equal(reportLink('a.html', {}), null);
  assert.equal(reportLink('a.html', { REPORT_URL_BASE: 'https://x.dev/r' }), 'https://x.dev/r/a.html');
  assert.equal(reportLink('a.html', { REPORT_URL_BASE: 'https://x.dev/view?f={file}' }), 'https://x.dev/view?f=a.html');
  assert.equal(
    reportLink('a.html', { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42' }),
    'https://github.com/o/r/actions/runs/42'
  );
});

// ---------- end to end ----------

test('runQa writes formats + job summary and notifies (config notify / formats)', async () => {
  const fixture = createServer();
  await new Promise((r) => fixture.listen(0, r));
  const base = `http://localhost:${fixture.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-out-'));
  const configPath = path.join(dir, 'qa.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ sites: [], maxPages: 5, checkExternalLinks: false, notify: { onlyOnIssues: true }, formats: ['markdown'] }));
  const summary = path.join(dir, 'step-summary.md');
  process.env.GITHUB_STEP_SUMMARY = summary;
  process.env.WEBHOOK_URL = `${hookUrl}/hook`;
  try {
    const config = loadConfig({ configPath, siteOverride: base });
    assert.deepEqual(config.notify, { onlyOnIssues: true });
    const result = await runQa(config, { outDir: dir, ai: false, notify: true, formats: ['sarif', 'junit', ...config.formats], jobSummary: true });
    const stem = result.htmlPath.replace(/\.html$/, '');
    assert.deepEqual(result.files, [`${stem}.sarif`, `${stem}.junit.xml`, `${stem}.md`]);
    for (const f of result.files) assert.ok(fs.existsSync(f));
    assert.ok(result.report.sites[0].counts.critical >= 1, 'fixture has broken links');
    assert.deepEqual(result.notified, ['webhook']);
    assert.match(fs.readFileSync(summary, 'utf8'), /\*\*Critical issues\*\*/);

    // The web server's default: no notifications, no CI files.
    const quiet = await runQa(config, { outDir: dir, ai: false });
    assert.deepEqual(quiet.notified, []);
    assert.deepEqual(quiet.files, []);
  } finally {
    clearEnv();
    fixture.close();
  }
  assert.equal(take().hook.report, path.basename(fs.readdirSync(dir).find((f) => f.endsWith('.html'))));
});
