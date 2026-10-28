import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runQa } from './run.js';
import { readHistory } from './report/history.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, 'web', 'index.html');
const KEEP_JOBS = 20; // finished jobs kept in memory
const KEEP_LINES = 2000; // log lines kept per job
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
// Reports contain crawled (possibly hostile) content: never let it run script on this origin.
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; sandbox";

/**
 * Local web UI: paste a URL, watch the scan, read the report in the browser.
 * Listens on 127.0.0.1 unless `host` says otherwise (Docker). One scan runs at a time.
 * Every request needs a local Host header (blocks DNS rebinding); state-changing requests must be
 * application/json from a same-origin page (blocks CSRF from other sites open in the browser).
 */
export async function startServer({ port = 4173, host = '127.0.0.1', configPath, outDir, autoScan, log = console.log }) {
  const jobs = new Map();
  let running = null;
  let seq = 0;

  function startJob({ url, maxPages, external, ai, email }) {
    const config = loadConfig({ configPath, siteOverride: url });
    if (maxPages) config.sites[0].maxPages = maxPages;
    if (typeof external === 'boolean') config.checkExternalLinks = external;

    const controller = new AbortController();
    const job = { id: String(++seq), url: config.sites[0].url, status: 'running', lines: [], listeners: new Set(), result: null, error: null, controller };
    const emit = (event, data) => {
      for (const res of job.listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const jobLog = (line) => {
      job.lines.push(line);
      if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
      emit('log', line);
      log(`[${job.id}] ${line}`);
    };
    jobs.set(job.id, job);
    running = job;

    runQa(config, { outDir, ai: ai !== false, email: Boolean(email), log: jobLog, signal: controller.signal })
      .then(({ report, htmlPath, subject, ai: aiResult, emailed }) => {
        const s = report.sites[0];
        job.status = 'done';
        job.result = {
          subject,
          reportUrl: `/reports/${encodeURIComponent(path.basename(htmlPath))}`,
          reportJsonUrl: `/reports/${encodeURIComponent(path.basename(htmlPath, '.html'))}.json`,
          counts: s.counts,
          fixed: s.fixed.length,
          pagesCrawled: s.pagesCrawled,
          ai: aiResult.text ? `${aiResult.provider} / ${aiResult.model}` : null,
          emailed,
        };
        emit('done', job.result);
        log(`[${job.id}] ${subject}\n[${job.id}] Report: http://localhost:${port}${job.result.reportUrl}`);
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          job.status = 'cancelled';
          emit('cancelled', {});
          return log(`[${job.id}] Scan cancelled`);
        }
        job.status = 'error';
        job.error = err.message;
        emit('failed', { error: err.message });
        log(`[${job.id}] ✖ ${err.message}`);
      })
      .finally(() => {
        if (running === job) running = null;
        for (const res of job.listeners) res.end();
        job.listeners.clear();
        job.controller = null;
        pruneJobs();
      });
    return job;
  }

  // Map keeps insertion order, so the first finished jobs are the oldest.
  function pruneJobs() {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_JOBS))) jobs.delete(j.id);
  }

  const localHosts = () => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  // Bound to a non-loopback address (Docker -p 8080:4173): the browser's port can differ from ours,
  // so accept loopback names on any port. Still blocks DNS rebinding, which needs a foreign hostname.
  const loopbackBound = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host);
  const hostAllowed = (h) => localHosts().includes(h) || (!loopbackBound && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', ...SECURITY });
      res.end(JSON.stringify(body));
    };

    try {
      const reqHost = String(req.headers.host).toLowerCase();
      if (!hostAllowed(reqHost)) return json(403, { error: 'Forbidden host' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin !== undefined && origin.toLowerCase() !== `http://${reqHost}`) return json(403, { error: 'Forbidden origin' });
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return json(415, { error: 'Content-Type must be application/json' });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', ...SECURITY });
        return res.end(fs.readFileSync(UI));
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        const probe = loadConfig({ configPath, siteOverride: 'https://example.com' });
        return json(200, {
          running: running ? { id: running.id, url: running.url } : null,
          aiConfigured: Boolean(probe.ai.provider && probe.ai.provider !== 'none'),
          emailConfigured: Boolean(probe.email.provider && probe.email.to.length),
          reports: listReports(outDir),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/scan') {
        if (running) return json(409, { error: `A scan of ${running.url} is already running.`, id: running.id });
        const body = await readJson(req);
        const target = normalizeTarget(body.url);
        if (!target) return json(400, { error: 'Enter a full web address, like https://example.com' });
        const job = startJob({ ...body, url: target, maxPages: clampInt(body.maxPages, 1, 500) });
        return json(202, { id: job.id, url: job.url });
      }

      const cancel = url.pathname.match(/^\/api\/scan\/(\d+)\/cancel$/);
      if (req.method === 'POST' && cancel) {
        const job = jobs.get(cancel[1]);
        if (!job) return json(404, { error: 'No such scan' });
        if (job.status !== 'running') return json(409, { error: `Scan is not running (${job.status}).`, status: job.status });
        job.controller.abort();
        return json(202, { id: job.id, status: 'cancelling' });
      }

      const scan = url.pathname.match(/^\/api\/scan\/(\d+)(\/events)?$/);
      if (req.method === 'GET' && scan) {
        const job = jobs.get(scan[1]);
        if (!job) return json(404, { error: 'No such scan' });
        if (!scan[2]) return json(200, { id: job.id, url: job.url, status: job.status, lines: job.lines, result: job.result, error: job.error });

        // Server-sent events: replay what's happened so far, then stream the rest.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SECURITY });
        res.write(`event: start\ndata: ${JSON.stringify({ id: job.id, url: job.url })}\n\n`);
        for (const line of job.lines) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
        if (job.status === 'done') return res.end(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
        if (job.status === 'error') return res.end(`event: failed\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
        if (job.status === 'cancelled') return res.end('event: cancelled\ndata: {}\n\n');
        job.listeners.add(res);
        req.on('close', () => job.listeners.delete(res));
        return;
      }

      const file = url.pathname.match(/^\/reports\/([^/]+\.(html|json))$/);
      if (req.method === 'GET' && file) {
        const name = path.basename(decodeURIComponent(file[1]));
        const full = path.join(outDir, name);
        if (!fs.existsSync(full)) return json(404, { error: 'Report not found' });
        const type = file[2] === 'html' ? { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': REPORT_CSP } : { 'content-type': 'application/json' };
        res.writeHead(200, { ...type, ...SECURITY });
        return res.end(fs.readFileSync(full));
      }

      // Past runs of one site (?site=<origin or host>), or every site seen in the saved reports.
      if (req.method === 'GET' && url.pathname === '/api/history') {
        return json(200, readHistory(outDir, url.searchParams.get('site')));
      }

      // Visual check images: /screenshots/<host>/<baseline|current|diff>/<slug>.png
      const shot = url.pathname.match(/^\/screenshots\/([a-z0-9-][a-z0-9.-]*)\/(baseline|current|diff)\/([a-z0-9-][a-z0-9._-]*\.png)$/i);
      if (req.method === 'GET' && shot) {
        const root = path.join(outDir, 'screenshots');
        const full = path.join(root, path.basename(shot[1]), shot[2], path.basename(shot[3]));
        if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) return json(404, { error: 'Screenshot not found' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', ...SECURITY });
        return res.end(fs.readFileSync(full));
      }

      json(404, { error: 'Not found' });
    } catch (err) {
      json(err.status || 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  port = actualPort;
  const address = `http://localhost:${actualPort}`;

  if (autoScan) {
    const target = normalizeTarget(autoScan);
    if (!target) throw new Error(`Not a valid URL: ${autoScan}`);
    startJob({ url: target });
  }

  return { server, url: address, close: () => new Promise((r) => server.close(r)) };
}

/** Accept "example.com" as well as full URLs; only http(s). */
function normalizeTarget(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let value = input.trim();
  // No scheme typed: local dev servers are almost always plain http, everything else https.
  if (!/^[a-z]+:\/\//i.test(value)) value = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`;
  try {
    const u = new URL(value);
    const hostOk = u.hostname.includes('.') || u.hostname === 'localhost';
    return /^https?:$/.test(u.protocol) && hostOk ? u.href : null;
  } catch {
    return null;
  }
}

function listReports(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .sort()
      .reverse()
      .slice(0, 20)
      .map((name) => ({
        name,
        url: `/reports/${encodeURIComponent(name)}`,
        jsonUrl: `/reports/${encodeURIComponent(name.replace(/\.html$/, '.json'))}`,
      }));
  } catch {
    return [];
  }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Expected a JSON object'), { status: 400 });
  return data;
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
