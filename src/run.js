import path from 'node:path';
import { chromium } from 'playwright';
import { crawlSite } from './crawler.js';
import { CHECKS, isEnabled } from './checks/index.js';
import { buildReport, loadPrevious, saveReport, subjectLine } from './report/build.js';
import { renderHtml } from './report/html.js';
import { summarize } from './ai/summarize.js';
import { sendEmail } from './email/send.js';
import { throwIfAborted } from './util.js';

/**
 * One full QA run: crawl + check every site, build and save the report, then the optional
 * AI summary and email. Shared by the CLI and the local web server.
 * Abort `signal` to stop: it rejects with "Scan cancelled" (the browser is still closed).
 */
export async function runQa(config, { outDir, ai: useAi = true, email: useEmail = false, log = () => {}, signal } = {}) {
  throwIfAborted(signal);
  const previous = loadPrevious(outDir);
  const browser = await chromium.launch();
  const siteResults = [];
  try {
    for (const site of config.sites) {
      throwIfAborted(signal);
      log(`▶ ${site.url}`);
      const pages = await crawlSite(browser, site, config, log, signal, { outDir });
      const checks = {};
      const active = CHECKS.filter((c) => isEnabled(c, config));
      for (const [n, check] of active.entries()) {
        throwIfAborted(signal);
        log(`  checking ${check.name} (${n + 1}/${active.length})…`);
        checks[check.name] = await runCheck(check, { browser, pages, site, config, previous, log, signal, outDir });
      }
      throwIfAborted(signal);
      siteResults.push({ site, pages, checks });
      log(`  done: ${active.map((c) => `${checks[c.name].issues.length} ${c.name}`).join(', ')} issues`);
    }
  } finally {
    await browser.close();
  }

  const report = buildReport(siteResults, previous);
  const ai = useAi ? await summarize(report, config.ai, log) : { skipped: 'AI summary turned off' };
  // Saved with the JSON so the web view can show everything from the file alone.
  report.ai = ai.text ? { text: ai.text, provider: ai.provider, model: ai.model } : null;
  report.thresholds = config.thresholds;
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

/** A check that crashes becomes a warning in the report instead of failing the whole run. */
async function runCheck(check, ctx) {
  try {
    const result = await check.run(ctx);
    return { checked: 0, ...result, issues: (result.issues || []).map((i) => ({ ...i, check: check.name })) };
  } catch (err) {
    if (ctx.signal?.aborted) throw new Error('Scan cancelled');
    ctx.log(`  ${check.name} check failed: ${err.message}`);
    return {
      checked: 0,
      error: err.message,
      issues: [{ check: check.name, severity: 'warning', key: 'check-failed', siteWide: true, page: ctx.site.url, message: `${check.title} check failed: ${err.message}` }],
    };
  }
}
