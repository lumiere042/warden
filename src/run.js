import path from 'node:path';
import { chromium } from 'playwright';
import { crawlSite } from './crawler.js';
import { checkLinks } from './checks/links.js';
import { checkMeta } from './checks/meta.js';
import { checkPerformance } from './checks/performance.js';
import { checkForms } from './checks/forms.js';
import { buildReport, loadPrevious, saveReport, subjectLine } from './report/build.js';
import { renderHtml } from './report/html.js';
import { summarize } from './ai/summarize.js';
import { sendEmail } from './email/send.js';

/**
 * One full QA run: crawl + check every site, build and save the report, then the optional
 * AI summary and email. Shared by the CLI and the local web server.
 */
export async function runQa(config, { outDir, ai: useAi = true, email: useEmail = false, log = () => {} }) {
  const browser = await chromium.launch();
  const siteResults = [];
  try {
    for (const site of config.sites) {
      log(`▶ ${site.url}`);
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

  const previous = loadPrevious(outDir);
  const report = buildReport(siteResults, previous);
  const ai = useAi ? await summarize(report, config.ai, log) : { skipped: 'AI summary turned off' };
  const fullHtml = renderHtml(report, ai);
  const htmlPath = saveReport(outDir, report, fullHtml, previous);
  const subject = subjectLine(report);

  let emailed = null;
  if (useEmail) {
    if (!config.email.provider) {
      log('Email skipped: EMAIL_PROVIDER is not set.');
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
      emailed = config.email.to;
      log(`Email sent to ${config.email.to.join(', ')}${id ? ` (${id})` : ''}`);
    }
  }

  return { report, ai, htmlPath, subject, emailed };
}
