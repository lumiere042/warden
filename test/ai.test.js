import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize } from '../src/ai/summarize.js';
import { loadConfig } from '../src/config.js';

const report = {
  generatedAt: new Date().toISOString(),
  sites: [{ url: 'https://example.com', pagesCrawled: 3, counts: { critical: 1 }, performance: {}, issues: [{ check: 'links', severity: 'critical', page: 'https://example.com/', message: 'Broken a (404)' }], fixed: [], untestedForms: [] }],
};
const ai = (over) => ({ provider: null, apiKey: null, model: null, baseUrl: null, promptFile: null, maxTokens: 1000, ...over });

test('no provider configured: skipped, not an error', async () => {
  const r = await summarize(report, ai());
  assert.match(r.skipped, /no AI provider/);
});

test('custom provider file + custom prompt file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ai-'));
  const providerFile = path.join(dir, 'my-provider.js');
  fs.writeFileSync(providerFile, `export async function complete({ system, prompt, model }) { return 'model=' + model + ' system=' + system.trim() + ' issues=' + JSON.parse(prompt).sites[0].issues.length; }`);
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'Be brief.');

  const r = await summarize(report, ai({ provider: providerFile, model: 'mine', apiKey: 'x', promptFile }));
  assert.equal(r.text, 'model=mine system=Be brief. issues=1');
});

test('openai-compatible provider sends a chat completion to AI_BASE_URL', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Summary from local model' } }] }));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const baseUrl = `http://localhost:${server.address().port}/v1`;
    const r = await summarize(report, ai({ provider: 'openai-compatible', model: 'llama3', baseUrl }));
    assert.equal(r.text, 'Summary from local model');
    assert.equal(received.url, '/v1/chat/completions');
    assert.equal(received.auth, undefined, 'no key needed for local servers');
    assert.equal(received.body.model, 'llama3');
    assert.equal(received.body.messages[0].role, 'system');
  } finally {
    server.close();
  }
});

test('provider errors are reported, not thrown', async () => {
  const r = await summarize(report, ai({ provider: 'gemini', apiKey: 'k' }));
  assert.match(r.skipped, /AI_MODEL/);
  const r2 = await summarize(report, ai({ provider: 'nope' }));
  assert.match(r2.skipped, /unknown AI_PROVIDER/);
});

test('provider is inferred from whichever vendor key is set', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['AI_PROVIDER', 'AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_MODEL']) delete process.env[k];
    process.env.GEMINI_API_KEY = 'g';
    let c = loadConfig({ siteOverride: 'https://example.com' });
    assert.equal(c.ai.provider, 'gemini');
    assert.equal(c.ai.apiKey, 'g');

    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_API_KEY = 'generic';
    c = loadConfig({ siteOverride: 'https://example.com' });
    assert.equal(c.ai.provider, 'anthropic');
    assert.equal(c.ai.apiKey, 'generic');
  } finally {
    process.env = saved;
  }
});
