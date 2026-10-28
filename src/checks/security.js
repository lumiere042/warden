import net from 'node:net';
import tls from 'node:tls';
import { sameSite } from '../util.js';
import { authHeaders } from '../browser.js';

// The config is merged shallowly, so a partial "security" block still gets the defaults.
const settings = (config = {}) => {
  const s = config.security || {};
  return { enabled: s.enabled !== false, headers: s.headers !== false, certWarnDays: s.certWarnDays ?? 21 };
};

const HEADERS = [
  { name: 'strict-transport-security', label: 'Strict-Transport-Security (HSTS)', why: 'browsers may still connect over plain http', httpsOnly: true },
  { name: 'content-security-policy', label: 'Content-Security-Policy', why: 'no second line of defence against injected scripts (XSS)' },
  { name: 'x-content-type-options', label: 'X-Content-Type-Options: nosniff', why: 'browsers may guess file types and run uploads as scripts' },
  { name: 'x-frame-options', label: 'X-Frame-Options (or CSP frame-ancestors)', why: 'other sites can frame the page (clickjacking)' },
  { name: 'referrer-policy', label: 'Referrer-Policy', why: 'full page URLs may leak to other sites' },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Security & HTTPS:
 * - security headers on the site's pages (one site-wide warning per header missing on the start page)
 * - mixed content: http:// resources on https pages (critical, per page)
 * - http:// should redirect to https://; an http-only site is a warning (except localhost)
 * - TLS certificate: expired / untrusted (critical), expiring within security.certWarnDays (warning)
 */
export default {
  name: 'security',
  title: 'Security & HTTPS',

  async collect({ page, response, result, site, config }) {
    if (!settings(config).enabled || !response || !sameSite(result.finalUrl, site.url)) return;
    const https = new URL(result.finalUrl).protocol === 'https:';
    const h = await response.allHeaders();
    const dom = await page.evaluate(() => {
      const urls = new Set();
      const add = (value) => {
        try {
          const u = new URL(value.trim(), document.baseURI);
          if (u.protocol === 'http:') urls.add(u.href);
        } catch {}
      };
      const each = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
      each('img[src], script[src], iframe[src], video[src], audio[src], source[src], track[src], embed[src], input[type=image][src]', (el) => add(el.getAttribute('src')));
      each('img[srcset], source[srcset]', (el) => el.getAttribute('srcset').split(',').forEach((s) => s.trim() && add(s.trim().split(/\s+/)[0])));
      each('video[poster]', (el) => add(el.getAttribute('poster')));
      each('object[data]', (el) => add(el.getAttribute('data')));
      each('link[href]', (el) => /\b(stylesheet|icon|preload|modulepreload|manifest)\b/i.test(el.rel) && add(el.getAttribute('href')));
      performance.getEntriesByType('resource').forEach((e) => e.name.startsWith('http:') && urls.add(e.name));
      const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
      return { mixed: [...urls].slice(0, 50), csp: meta('meta[http-equiv="content-security-policy" i]'), referrer: meta('meta[name="referrer" i]') };
    });
    result.data.security = {
      https,
      headers: {
        'strict-transport-security': Boolean(h['strict-transport-security']),
        'content-security-policy': Boolean(h['content-security-policy'] || dom.csp),
        'x-content-type-options': /nosniff/i.test(h['x-content-type-options'] || ''),
        'x-frame-options': Boolean(h['x-frame-options']) || /frame-ancestors/i.test(h['content-security-policy'] || ''),
        'referrer-policy': Boolean(h['referrer-policy'] || dom.referrer),
      },
      mixedContent: https ? dom.mixed : [],
    };
  },

  async run({ pages, site, config }) {
    if (!settings(config).enabled) return { checked: 0, issues: [] };
    const result = checkSecurity(pages, site, config);
    result.issues.push(...(await checkTransport(site, pages, config)));
    return result;
  },
};

/** Header and mixed-content issues from what collect() recorded. No network. */
export function checkSecurity(pages, site, config) {
  const opts = settings(config);
  if (!opts.enabled) return { checked: 0, issues: [] };
  const checked = pages.filter((p) => p.data?.security?.headers && !p.error && p.status < 400);
  const start = checked.find((p) => p.source === 'start');
  const issues = [];

  for (const h of opts.headers ? HEADERS : []) {
    const relevant = checked.filter((p) => !h.httpsOnly || p.data.security.https);
    const missing = relevant.filter((p) => !p.data.security.headers[h.name]);
    // Judged on the start page; the other pages only fill in the list. Without one, any page counts.
    const anchor = start && relevant.includes(start) ? start : missing[0];
    if (!anchor || !missing.includes(anchor)) continue;
    issues.push({
      check: 'security',
      severity: 'warning',
      key: `header:${h.name}`,
      siteWide: true,
      page: anchor.url,
      message: `Missing ${h.label} header${relevant.length > 1 ? ` on ${missing.length} of ${relevant.length} pages` : ''}: ${h.why}`,
      detail: { header: h.name, pages: missing.map((p) => p.url) },
    });
  }

  for (const p of checked) {
    const urls = p.data.security.mixedContent || [];
    if (!urls.length) continue;
    const more = urls.length > 3 ? ` (+${urls.length - 3} more)` : '';
    issues.push({
      check: 'security',
      severity: 'critical',
      key: 'mixed-content',
      page: p.url,
      message: `Mixed content: ${plural(urls.length, 'resource')} loaded over insecure http:// on an https page: ${urls.slice(0, 3).join(', ')}${more}`,
      detail: { urls },
    });
  }

  return { checked: checked.length, issues, summary: { https: new URL(site.url).protocol === 'https:' } };
}

const isLocal = (host) => /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(host) || host.endsWith('.localhost');

/** HTTPS on the site as a whole: http -> https redirect and the TLS certificate. Site-wide issues. */
export async function checkTransport(site, pages, config) {
  const opts = settings(config);
  const url = new URL(site.url);
  const issue = (severity, key, message, detail) => ({ check: 'security', severity, key, siteWide: true, page: site.url, message, detail });
  if (url.protocol === 'http:') {
    return isLocal(url.hostname) ? [] : [issue('warning', 'no-https', 'Site is not served over HTTPS: browsers mark it "Not secure"')];
  }

  const start = pages.find((p) => p.source === 'start') || pages[0];
  const siteUp = start && !start.error && start.status < 400;
  const issues = [];

  const httpUrl = new URL(site.url);
  httpUrl.protocol = 'http:';
  const redirect = await httpRedirectIssue(httpUrl.href, config);
  if (redirect && (siteUp || !redirect.detail.error)) issues.push(issue('warning', 'http-redirect', redirect.message, redirect.detail));

  // The start page may redirect to another host (example.com -> www.example.com): check both certificates.
  const hosts = new Map([[url.hostname, url.port || 443]]);
  const final = start?.finalUrl && new URL(start.finalUrl);
  if (final?.protocol === 'https:' && sameSite(final.href, site.url)) hosts.set(final.hostname, final.port || 443);
  for (const [host, port] of hosts) {
    try {
      const cert = await readCertificate(host, Number(port), config.timeoutMs || 10000);
      const problem = certIssue(cert, new Date(), opts.certWarnDays);
      if (problem) issues.push(issue(problem.severity, `${problem.key}:${host}`, `${host}: ${problem.message}`, { host, ...cert }));
    } catch (err) {
      // An unreachable site is already reported by the pages check.
      if (siteUp) issues.push(issue('warning', `cert-unreadable:${host}`, `${host}: could not read the TLS certificate (${err.message})`, { host }));
    }
  }
  return issues;
}

/** Follows http:// redirects (up to `maxHops`) and returns an issue unless they end on https://. */
export async function httpRedirectIssue(httpUrl, config, maxHops = 5) {
  const label = httpUrl.replace(/\/$/, '');
  let url = httpUrl;
  for (let hops = 0; ; hops++) {
    if (new URL(url).protocol === 'https:') return null;
    if (hops > maxHops) return { message: `${label} takes more than ${maxHops} redirects without reaching https://`, detail: { url: httpUrl, finalUrl: url } };
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': config.userAgent, ...authHeaders(config, url) },
        signal: AbortSignal.timeout(config.timeoutMs || 10000),
      });
    } catch (err) {
      const error = err.cause?.code || err.message;
      return { message: `${label} does not respond (${error}): visitors who type the address without https:// may get an error`, detail: { url: httpUrl, finalUrl: url, error } };
    }
    await res.body?.cancel().catch(() => {});
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!location) {
      const message = res.ok
        ? `${label} serves the site over plain http instead of redirecting to https://`
        : `${label} does not redirect to https:// (returns ${res.status})`;
      return { message, detail: { url: httpUrl, finalUrl: url, status: res.status } };
    }
    url = new URL(location, url).href;
  }
}

/** The server's TLS certificate, read even when it isn't trusted (so expiry can still be reported). */
export function readCertificate(host, port = 443, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const hostname = host.replace(/^\[|\]$/g, '');
    const options = { host: hostname, port, rejectUnauthorized: false, ...(net.isIP(hostname) ? {} : { servername: hostname }) };
    const socket = tls.connect(options, () => {
      const cert = socket.getPeerCertificate();
      resolve({
        validTo: cert?.valid_to || null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
      });
      socket.destroy();
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    socket.on('error', (err) => reject(new Error(err.code || err.message)));
  });
}

/** The problem with a certificate, or null: expired or untrusted is critical, expiring within warnDays a warning. */
export function certIssue({ validTo, authorized, authorizationError }, now = new Date(), warnDays = 21) {
  const expires = validTo ? new Date(validTo) : null;
  const date = expires && !isNaN(expires) ? expires.toISOString().slice(0, 10) : null;
  if (date && expires <= now) return { severity: 'critical', key: 'cert-expired', message: `TLS certificate expired on ${date}` };
  if (!authorized) return { severity: 'critical', key: 'cert-invalid', message: `TLS certificate is not trusted (${authorizationError || 'unknown error'})` };
  if (!date) return null;
  const days = Math.floor((expires - now) / 86400000);
  if (days <= warnDays) return { severity: 'warning', key: 'cert-expiring', message: `TLS certificate expires in ${plural(days, 'day')} (${date})` };
  return null;
}
