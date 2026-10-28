#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { crawlSite } from './crawler.js';
import { checkLinks } from './checks/links.js';
import { checkMeta } from './checks/meta.js';
import { checkPerformance } from './checks/performance.js';
import { checkForms } from './checks/forms.js';
import { buildReport, loadPrevious, saveReport, subjectLine } from './report/build.js';
import { renderHtml } from './report/html.js';
import { summarize } from './ai/summarize.js';
import { sendEmail } from './email/send.js';

const HELP = `website-qa — nightly QA for websites

Usage: npm run qa -- [options]

  --config <file>   config file (default: qa.config.json)
  --site <url>      check this URL instead of the sites in the config
  --no-email        write the report but don't email it
  --no-ai           skip the AI summary
  --out <dir>       where reports are written (default: reports)
  --strict          exit with code 1 when critical issues are found
  -h, --help        show this help
`;

async function main() {
  const { values: args } = parseArgs({
    options: {
      config: { type: 'string' },
      site: { type: 'string' },
      'no-email': { type: 'boolean', default: false },
      'no-ai': { type: 'boolean', default: false },
      out: { type: 'string', default: 'reports' },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) return console.log(HELP);

  const config = loadConfig({ configPath: args.config, siteOverride: args.site });
  const outDir = path.resolve(args.out);
  const log = (msg) => console.log(msg);

  const browser = await chromium.launch();
  const siteResults = [];
  try {
    for (const site of config.sites) {
      log(`\n▶ ${site.url}`);
      const pages = await crawlSite(browser, site, config, log);
      log(`  checking links…`);
      const links = await checkLinks(pages, site, config);
      log(`  testing forms…`);
      const forms = await checkForms(browser, pages, site, config);
      const meta = checkMeta(pages);
      const performance = checkPerformance(pages, config);
      siteResults.push({ site, pages, links, forms, meta, performance });
      const n = (r) => r.issues.length;
      log(`  done: ${n(links)} link, ${n(forms)} form, ${n(meta)} meta, ${n(performance)} performance issues`);
    }
  } finally {
    await browser.close();
  }

  const report = buildReport(siteResults, loadPrevious(outDir));
  const ai = args['no-ai'] ? { skipped: '--no-ai' } : await summarize(report, config.ai, log);
  const fullHtml = renderHtml(report, ai);
  const htmlPath = saveReport(outDir, report, fullHtml);
  const subject = subjectLine(report);
  log(`\n${subject}\nReport: ${htmlPath}`);

  if (!args['no-email']) {
    if (!config.email.provider) {
      log('Email skipped: EMAIL_PROVIDER is not set (use --no-email to silence this).');
    } else {
      const id = await sendEmail(
        {
          subject,
          html: renderHtml(report, ai, { maxRows: 25 }),
          attachmentHtml: fullHtml,
          attachmentName: path.basename(htmlPath),
        },
        config.email
      );
      log(`Email sent to ${config.email.to.join(', ')}${id ? ` (${id})` : ''}`);
    }
  }

  const critical = report.sites.reduce((n, s) => n + s.counts.critical, 0);
  if (args.strict && critical) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exitCode = 2;
});
