#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { runQa } from './run.js';
import { startServer } from './server.js';

const HELP = `warden — automated QA for websites

Usage:
  npm run qa -- [url] [options]       run once, save the report (and email it)
  npm run serve -- [url] [options]    open the local web page; paste a URL there to scan

  url               site to check (overrides the sites in the config)
  --config <file>   config file (default: qa.config.json)
  --site <url>      same as giving a url
  --no-email        write the report but don't email it
  --no-ai           skip the AI summary
  --out <dir>       where reports are written (default: reports)
  --strict          exit with code 1 when critical issues are found
  --serve           start the local web page instead of a one-off run
  --port <n>        port for --serve (default: 4173)
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
      out: { type: 'string', default: 'reports' },
      strict: { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
      port: { type: 'string', default: process.env.PORT || '4173' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) return console.log(HELP);

  const site = args.site || positionals[0];
  const outDir = path.resolve(args.out);

  if (args.serve) {
    const { url } = await startServer({ port: Number(args.port), configPath: args.config, outDir, autoScan: site });
    console.log(`\n  Warden is running at ${url}\n`);
    console.log(site ? `  Scanning ${site} now. Open the link to watch it.\n` : '  Open the link and paste a URL to scan.\n');
    console.log('  Press Ctrl+C to stop.\n');
    return;
  }

  const config = loadConfig({ configPath: args.config, siteOverride: site });
  const { report, htmlPath, subject } = await runQa(config, {
    outDir,
    ai: !args['no-ai'],
    email: !args['no-email'],
    log: (msg) => console.log(msg),
  });
  console.log(`\n${subject}\nReport: ${htmlPath}`);

  const critical = report.sites.reduce((n, s) => n + s.counts.critical, 0);
  if (args.strict && critical) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exitCode = 2;
});
