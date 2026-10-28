import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runQa } from './run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, 'web', 'index.html');

/**
 * Local web UI: paste a URL, watch the scan, read the report in the browser.
 * Listens on 127.0.0.1 only. One scan runs at a time.
 */
export async function startServer({ port = 4173, configPath, outDir, autoScan, log = console.log }) {
  const jobs = new Map();
  let running = null;
  let seq = 0;

  function startJob({ url, maxPages, external, ai, email }) {
    const config = loadConfig({ configPath, siteOverride: url });
    if (maxPages) config.sites[0].maxPages = maxPages;
    if (typeof external === 'boolean') config.checkExternalLinks = external;

    const job = { id: String(++seq), url: config.sites[0].url, status: 'running', lines: [], listeners: new Set(), result: null, error: null };
    const emit = (event, data) => {
      for (const res of job.listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const jobLog = (line) => {
      job.lines.push(line);
      emit('log', line);
      log(`[${job.id}] ${line}`);
    };
    jobs.set(job.id, job);
    running = job;

    runQa(config, { outDir, ai: ai !== false, email: Boolean(email), log: jobLog })
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
        job.status = 'error';
        job.error = err.message;
        emit('failed', { error: err.message });
        log(`[${job.id}] ✖ ${err.message}`);
      })
      .finally(() => {
        if (running === job) running = null;
        for (const res of job.listeners) res.end();
        job.listeners.clear();
      });
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

      const scan = url.pathname.match(/^\/api\/scan\/(\d+)(\/events)?$/);
      if (req.method === 'GET' && scan) {
        const job = jobs.get(scan[1]);
        if (!job) return json(404, { error: 'No such scan' });
        if (!scan[2]) return json(200, { id: job.id, url: job.url, status: job.status, lines: job.lines, result: job.result, error: job.error });

        // Server-sent events: replay what's happened so far, then stream the rest.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: start\ndata: ${JSON.stringify({ id: job.id, url: job.url })}\n\n`);
        for (const line of job.lines) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
        if (job.status === 'done') return res.end(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
        if (job.status === 'error') return res.end(`event: failed\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
        job.listeners.add(res);
        req.on('close', () => job.listeners.delete(res));
        return;
      }

      const file = url.pathname.match(/^\/reports\/([^/]+\.(html|json))$/);
      if (req.method === 'GET' && file) {
        const name = path.basename(decodeURIComponent(file[1]));
        const full = path.join(outDir, name);
        if (!fs.existsSync(full)) return json(404, { error: 'Report not found' });
        res.writeHead(200, { 'content-type': file[2] === 'html' ? 'text/html; charset=utf-8' : 'application/json' });
        return res.end(fs.readFileSync(full));
      }

      json(404, { error: 'Not found' });
    } catch (err) {
      json(500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
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
    if (body.length > 10000) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
