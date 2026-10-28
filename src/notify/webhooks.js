import { pathOf } from '../util.js';
import { describe } from '../report/formats.js';

/**
 * Chat notifications after a run. Each one is turned on by its env var:
 * SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, TEAMS_WEBHOOK_URL, and WEBHOOK_URL (plain JSON for your own endpoint).
 */
const TARGETS = { slack: 'SLACK_WEBHOOK_URL', discord: 'DISCORD_WEBHOOK_URL', teams: 'TEAMS_WEBHOOK_URL', webhook: 'WEBHOOK_URL' };
const LIMITS = { slack: 3000, discord: 2000, teams: 4000 };

export const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Where the report can be opened. REPORT_URL_BASE gets the file name appended (or replaces a {file}
 * placeholder). Without it, inside GitHub Actions, the run page (where the report artifact lives).
 */
export function reportLink(reportName, env = process.env) {
  const base = (env.REPORT_URL_BASE || '').trim();
  if (base) return base.includes('{file}') ? base.replaceAll('{file}', encodeURIComponent(reportName)) : `${base.replace(/\/+$/, '')}/${encodeURIComponent(reportName)}`;
  if (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY) {
    return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return null;
}

/** The facts every message is built from. */
export function summaryOf(report, { subject, reportName, maxCritical = 10 } = {}) {
  const sites = report.sites.map((s) => ({
    url: s.url,
    pagesCrawled: s.pagesCrawled,
    critical: s.counts?.critical || 0,
    warning: s.counts?.warning || 0,
    new: s.counts?.new || 0,
    fixed: s.fixed?.length || 0,
  }));
  const critical = report.sites
    .flatMap((s) => s.issues.filter((i) => i.severity === 'critical').map((i) => ({ site: s.url, page: i.page || s.url, check: i.check, message: describe(i), isNew: Boolean(i.isNew) })))
    .slice(0, maxCritical);
  return {
    subject,
    generatedAt: report.generatedAt,
    sites,
    totals: ['critical', 'warning', 'new', 'fixed'].reduce((t, k) => ({ ...t, [k]: sites.reduce((n, s) => n + s[k], 0) }), {}),
    critical,
    report: reportName || null,
    reportUrl: reportName ? reportLink(reportName) : null,
    ai: report.ai?.text || null,
  };
}

const countsText = (s) => `${s.critical} critical, ${s.warning} warning${s.warning === 1 ? '' : 's'}, ${s.new} new, ${s.fixed} fixed`;

/** The platform-neutral body (lines), with bold/escape/link rules supplied per platform. */
function body(sum, { bold, esc, link }) {
  const lines = sum.sites.map((s) => `${bold(esc(new URL(s.url).host))}: ${countsText(s)}`);
  const top = sum.critical.slice(0, 5);
  if (top.length) {
    lines.push('', bold('Top critical issues'));
    for (const i of top) lines.push(`• ${esc(pathOf(i.page))} — ${esc(i.message)}`);
    const more = sum.totals.critical - top.length;
    if (more > 0) lines.push(`…and ${more} more`);
  }
  lines.push('', sum.reportUrl ? link(sum.reportUrl, 'Open the report') : `Report: ${esc(sum.report || 'see the reports folder')}`);
  return lines.join('\n');
}

export function slackPayload(sum) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = body(sum, { bold: (s) => `*${s}*`, esc, link: (url, label) => `<${url}|${label}>` });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: clip(sum.subject, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(text, LIMITS.slack) } },
  ];
  if (sum.ai) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*AI summary*\n${esc(sum.ai)}`, LIMITS.slack) } });
  return { text: clip(sum.subject, LIMITS.slack), blocks };
}

export function discordPayload(sum) {
  const esc = (s) => String(s).replace(/([\\*_~`|>[\]])/g, '\\$1');
  const main = `**${esc(sum.subject)}**\n${body(sum, { bold: (s) => `**${s}**`, esc, link: (url, label) => `[${label}](<${url}>)` })}`;
  const room = LIMITS.discord - main.length - 20;
  const content = sum.ai && room > 100 ? `${main}\n\n**AI summary**\n${clip(sum.ai, room)}` : main;
  // allowed_mentions: never ping @everyone because a page title happened to contain it.
  return { username: 'Warden', content: clip(content, LIMITS.discord), allowed_mentions: { parse: [] } };
}

/** Adaptive Card, the format Teams "Workflows" webhooks expect (the old connector cards are retired). */
export function teamsPayload(sum) {
  const text = body(sum, { bold: (s) => `**${s}**`, esc: String, link: (url, label) => `[${label}](${url})` });
  const block = (t, extra = {}) => ({ type: 'TextBlock', text: t, wrap: true, ...extra });
  const content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      block(clip(sum.subject, 400), { weight: 'Bolder', size: 'Medium', color: sum.totals.critical ? 'Attention' : 'Good' }),
      // Teams TextBlocks need a blank line between list items to keep line breaks.
      block(clip(text.replace(/\n/g, '\n\n'), LIMITS.teams)),
      ...(sum.ai ? [block('AI summary', { weight: 'Bolder', spacing: 'Medium' }), block(clip(sum.ai, LIMITS.teams))] : []),
    ],
    ...(sum.reportUrl ? { actions: [{ type: 'Action.OpenUrl', title: 'Open the report', url: sum.reportUrl }] } : {}),
  };
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }] };
}

const PAYLOADS = { slack: slackPayload, discord: discordPayload, teams: teamsPayload, webhook: (sum) => sum };

/**
 * Post to every configured webhook. Never throws: a failed webhook is logged and skipped.
 * Returns the names that were sent, e.g. ['slack', 'webhook'].
 */
export async function sendNotifications(report, { subject, reportName, onlyOnIssues = false, log = () => {}, env = process.env } = {}) {
  const targets = Object.entries(TARGETS).filter(([, key]) => env[key]);
  if (!targets.length) return [];
  const sum = summaryOf(report, { subject, reportName });
  if (onlyOnIssues && !sum.totals.critical && !sum.totals.new) {
    log('Notifications skipped: no critical or new issues.');
    return [];
  }
  const results = await Promise.all(
    targets.map(async ([name, key]) => {
      try {
        const res = await fetch(env[key], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(PAYLOADS[name](sum)),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${clip((await res.text().catch(() => '')).trim(), 200)}`.trim());
        log(`Notified ${name}`);
        return name;
      } catch (err) {
        log(`Webhook to ${name} failed: ${err.message}`);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}
