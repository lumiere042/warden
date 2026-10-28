import fs from 'node:fs';
import path from 'node:path';
import { devices } from 'playwright';
import { sameSite } from './util.js';

/**
 * Options for a fresh browser context, from config:
 *   device       Playwright device name (e.g. "Pixel 7") for a mobile run
 *   auth         { storageState: "state.json", headers: {...}, cookies: [...] }
 *   AUTH_USERNAME / AUTH_PASSWORD env vars: HTTP basic auth (passwords never go in the config file)
 * Throws on an unknown device, so call it once up front to fail fast.
 */
export function contextOptions(config, extra = {}) {
  const opts = { userAgent: config.userAgent };
  if (config.device) {
    const device = devices[config.device];
    if (!device) throw new Error(`Unknown device "${config.device}" (use a Playwright device name, e.g. "Pixel 7" or "iPhone 15")`);
    // Keep the device's user agent so sites serve their mobile version, but still say who we are.
    Object.assign(opts, device, { userAgent: `${device.userAgent} ${config.userAgent}` });
  }
  const auth = config.auth || {};
  if (auth.storageState) {
    opts.storageState = path.resolve(auth.storageState);
    if (!fs.existsSync(opts.storageState)) throw new Error(`auth.storageState file not found: ${opts.storageState}`);
  }
  if (auth.headers) opts.extraHTTPHeaders = expandEnv(auth.headers);
  if (process.env.AUTH_USERNAME) opts.httpCredentials = { username: process.env.AUTH_USERNAME, password: process.env.AUTH_PASSWORD || '' };
  return { ...opts, ...extra };
}

/** A new browser context with the user agent, device and auth from config applied. */
export async function newContext(browser, config, extra = {}) {
  const context = await browser.newContext(contextOptions(config, extra));
  // Each cookie needs a url, or a domain + path (Playwright's rule).
  if (config.auth?.cookies?.length) await context.addCookies(config.auth.cookies);
  return context;
}

/**
 * Auth headers for plain fetch() calls (sitemaps, link probes), so they see what the browser sees.
 * Only sent to the sites being checked, never to external links.
 */
export function authHeaders(config, url) {
  if (!(config.sites || []).some((s) => sameSite(url, s.url))) return {};
  const headers = config.auth?.headers ? expandEnv(config.auth.headers) : {};
  if (process.env.AUTH_USERNAME) {
    headers.authorization = 'Basic ' + Buffer.from(`${process.env.AUTH_USERNAME}:${process.env.AUTH_PASSWORD || ''}`).toString('base64');
  }
  return headers;
}

// Header values may reference env vars, e.g. "Bearer ${STAGING_TOKEN}", to keep tokens out of the config file.
function expandEnv(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')]));
}
