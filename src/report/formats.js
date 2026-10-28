import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathOf } from '../util.js';

/** Extra report files for CI: --format sarif,junit,markdown (or "formats" in qa.config.json). */
export const FORMATS = { sarif: '.sarif', junit: '.junit.xml', markdown: '.md' };

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const hostOf = (url) => new URL(url).host;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "message: target url" — link issues keep the broken URL in detail, not in the message. */
export function describe(i) {
  const target = i.detail?.url;
  return target && target !== i.page && !i.message.includes(target) ? `${i.message}: ${target}` : i.message;
}

/** Every check that ran on a site (from report.checks when present), plus any that reported issues. */
function checksOf(site) {
  return [...new Set([...Object.keys(site.checks || {}), ...site.issues.map((i) => i.check)])];
}
const checkTitle = (site, check) => site.checks?.[check]?.title || check;

/** Validate a "sarif,junit" list; returns [] for empty input. */
export function parseFormats(list) {
  const formats = (Array.isArray(list) ? list : String(list || '').split(','))
    .map((f) => String(f).trim().toLowerCase())
    .filter(Boolean)
    .map((f) => (f === 'md' ? 'markdown' : f === 'xml' ? 'junit' : f));
  const bad = formats.filter((f) => !FORMATS[f]);
  if (bad.length) throw new Error(`Unknown format "${bad.join(', ')}" (use ${Object.keys(FORMATS).join(', ')})`);
  return [...new Set(formats)];
}

/** Write <base>.sarif / .junit.xml / .md next to the HTML report. Returns the paths written. */
export function writeFormats(base, report, formats, opts = {}) {
  const render = { sarif: () => JSON.stringify(toSarif(report), null, 2), junit: () => toJunit(report), markdown: () => toMarkdown(report, opts) };
  return parseFormats(formats).map((f) => {
    const file = base + FORMATS[f];
    fs.writeFileSync(file, render[f]());
    return file;
  });
}

/** Append the Markdown summary to the GitHub Actions job summary, when running in Actions. */
export function writeJobSummary(report, opts = {}) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  fs.appendFileSync(file, toMarkdown(report, opts) + '\n');
  return true;
}

// ---------- SARIF 2.1.0 ----------

export function toSarif(report) {
  const checks = [...new Set(report.sites.flatMap(checksOf))];
  const site0 = (check) => report.sites.find((s) => s.checks?.[check]) || {};
  const results = report.sites.flatMap((s) =>
    s.issues.map((i) => ({
      ruleId: i.check,
      ruleIndex: checks.indexOf(i.check),
      level: i.severity === 'critical' ? 'error' : 'warning',
      message: { text: `${describe(i)} (${hostOf(s.url)}${pathOf(i.page || s.url)})` },
      locations: [{ physicalLocation: { artifactLocation: { uri: i.page || s.url } } }],
      partialFingerprints: { 'wardenIssue/v1': crypto.createHash('sha256').update(i.id || `${s.url}|${i.check}|${i.page}|${i.key}`).digest('hex') },
      properties: { site: s.url, key: i.key, isNew: Boolean(i.isNew), ...(i.siteWide ? { siteWide: true } : {}) },
    }))
  );
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Warden',
            version,
            informationUri: 'https://github.com/lumiere042/warden',
            rules: checks.map((c) => ({ id: c, name: c, shortDescription: { text: `Warden ${checkTitle(site0(c), c)} check` } })),
          },
        },
        results,
      },
    ],
  };
}

// ---------- JUnit XML ----------

export const escapeXml = (s) =>
  String(s ?? '')
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** One testsuite per site per check; critical issues fail, warnings pass with a note in system-out. */
export function toJunit(report) {
  const e = escapeXml;
  let tests = 0;
  let failures = 0;
  const suites = report.sites.flatMap((s) => {
    const host = hostOf(s.url);
    return checksOf(s).map((check) => {
      const issues = s.issues.filter((i) => i.check === check);
      const fails = issues.filter((i) => i.severity === 'critical').length;
      const cases = issues.length
        ? issues.map((i) => {
            const name = `${pathOf(i.page || s.url)}: ${describe(i)}`;
            const body =
              i.severity === 'critical'
                ? `<failure type="critical" message="${e(describe(i))}">${e(`${i.page || s.url}\n${describe(i)}`)}</failure>`
                : `<system-out>${e(`warning: ${describe(i)}\n${i.page || s.url}`)}</system-out>`;
            return `    <testcase classname="${e(`${host}.${check}`)}" name="${e(name)}">${body}</testcase>`;
          })
        : [`    <testcase classname="${e(`${host}.${check}`)}" name="no issues"/>`];
      tests += cases.length;
      failures += fails;
      return [
        `  <testsuite name="${e(`${host}: ${checkTitle(s, check)}`)}" tests="${cases.length}" failures="${fails}" errors="0" skipped="0">`,
        ...cases,
        '  </testsuite>',
      ].join('\n');
    });
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="Warden" tests="${tests}" failures="${failures}" errors="0">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

// ---------- Markdown (also the GitHub job summary) ----------

const md = (s) => String(s ?? '').replace(/[\\`*_[\]|<>]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`)).replace(/\s*\n\s*/g, ' ');

export function toMarkdown(report, { subject, reportName, reportUrl, maxCritical = 30 } = {}) {
  const out = [`## ${md(subject || 'Warden QA report')}`, ''];
  for (const s of report.sites) {
    const c = s.counts || {};
    const fixed = s.fixed?.length || 0;
    out.push(`### ${md(hostOf(s.url))}`, '');
    out.push(
      `${plural(s.pagesCrawled ?? 0, 'page')} crawled · **${c.critical || 0} critical** · ${plural(c.warning || 0, 'warning')} · ${c.new || 0} new · ${fixed} fixed`,
      ''
    );
    out.push('| Check | Critical | Warnings |', '| --- | ---: | ---: |');
    for (const check of checksOf(s)) {
      const of = (sev) => s.issues.filter((i) => i.check === check && i.severity === sev).length;
      out.push(`| ${md(checkTitle(s, check))} | ${of('critical')} | ${of('warning')} |`);
    }
    out.push(`| **Total** | **${c.critical || 0}** | **${c.warning || 0}** |`, '');
    const critical = s.issues.filter((i) => i.severity === 'critical');
    if (critical.length) {
      out.push('**Critical issues**', '');
      for (const i of critical.slice(0, maxCritical)) {
        out.push(`- \`${pathOf(i.page || s.url).replace(/`/g, '')}\` ${md(describe(i))}${i.isNew ? ' _(new)_' : ''}`);
      }
      if (critical.length > maxCritical) out.push(`- …and ${critical.length - maxCritical} more in the full report`);
      out.push('');
    }
  }
  if (report.ai?.text) out.push('### AI summary', '', report.ai.text.trim(), '');
  if (reportUrl) out.push(`[Open the full report](${reportUrl})`, '');
  else if (reportName) out.push(`Full report: \`${reportName}\``, '');
  return out.join('\n');
}
