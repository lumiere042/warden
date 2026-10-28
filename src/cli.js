#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { runQa } from './run.js';
import { parseFormats } from './report/formats.js';
import { startServer } from './server.js';

const HELP = `warden — automated QA for websites

Usage:
  npm run qa -- [url] [options]       run once, save the report (and email it)
  npm run serve -- [url] [options]    open the local web page; paste a URL there to scan
  warden [url] [options]              same, when installed with npm i -g (or via npx)

  url               site to check (overrides the sites in the config)
  --config <file>   config file (default: qa.config.json)
  --site <url>      same as giving a url
  --no-email        write the report but don't email it
  --no-ai           skip the AI summary
  --no-notify       don't post to the Slack/Discord/Teams/webhook URLs set in env
  --format <list>   also write sarif, junit and/or markdown files, e.g. --format sarif,junit
  --out <dir>       where reports are written (default: reports)
  --strict          exit with code 1 when critical issues are found
  --serve           start the local web page instead of a one-off run
  --port <n>        port for --serve (default: 4173)
  --host <addr>     address --serve listens on (default: 127.0.0.1; use 0.0.0.0 in Docker)
  -v, --version     print the version
  -h, --help        show this help
`;

async function main() {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      site: { type: 'string' },
      'no-email': { type: 'boolean', default: false },
      'no-ai': { type: 'boolean', default: false },
      'no-notify': { type: 'boolean', default: false },
      format: { type: 'string' },
      out: { type: 'string', default: 'reports' },
      strict: { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      port: { type: 'string', default: process.env.PORT || '4173' },
      host: { type: 'string', default: '127.0.0.1' },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(readVersion());

  const site = args.site || positionals[0];
  const outDir = path.resolve(args.out);

  if (args.serve) {
    if (!isLoopback(args.host)) {
      console.warn(
        `\n  ⚠ Listening on ${args.host}: anyone who can reach this machine on port ${args.port} can start scans and read reports.`
      );
    }
    const { url } = await startServer({ host: args.host, port: Number(args.port), configPath: args.config, outDir, autoScan: site });
    console.log(`\n  Warden is running at ${url}\n`);
    console.log(site ? `  Scanning ${site} now. Open the link to watch it.\n` : '  Open the link and paste a URL to scan.\n');
    console.log('  Press Ctrl+C to stop.\n');
    return;
  }

  const config = loadConfig({ configPath: args.config, siteOverride: site });
  const { report, htmlPath, files, subject } = await runQa(config, {
    outDir,
    ai: !args['no-ai'],
    email: !args['no-email'],
    notify: !args['no-notify'],
    formats: parseFormats(args.format ?? config.formats),
    jobSummary: true, // only writes when GITHUB_STEP_SUMMARY is set (GitHub Actions)
    log: (msg) => console.log(msg),
  });
  console.log(`\n${subject}\nReport: ${htmlPath}`);
  for (const file of files) console.log(`        ${file}`);

  const critical = report.sites.reduce((n, s) => n + s.counts.critical, 0);
  if (args.strict && critical) process.exitCode = 1;
}

function readVersion() {
  const pkg = new URL('../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

main().catch((err) => {
  // Playwright is installed but its browser isn't (common after a global or npx install).
  if (/Executable doesn't exist/i.test(err.message)) {
    console.error('\n✖ Chromium for Playwright is not installed.\n  Run: npx playwright install chromium');
  } else {
    console.error(`\n✖ ${err.message}`);
  }
  process.exitCode = 2;
});
