import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  maxPages: 50,
  // marginPct: a page not flagged last run must go this % over a limit to be flagged (stops timing noise flip-flopping)
  thresholds: { loadMs: 3000, lcpMs: 2500, pageWeightKb: 3000, clsScore: 0.1, marginPct: 10 },
  checkExternalLinks: true,
  exclude: ['mailto:', 'tel:', 'javascript:'],
  concurrency: 8, // link probes in flight
  linkHostConcurrency: 2, // link probes in flight to any one host
  ignore: [], // [{ check?, key?, page?, match?, reason? }]: matching issues are left out of the report and counts
  timeoutMs: 10000, // per link probe / sitemap fetch
  pageConcurrency: 3, // pages loaded in the browser at once
  pageTimeoutMs: 30000, // per page load in the browser
  device: null, // Playwright device name for a mobile run, e.g. "Pixel 7"
  auth: {}, // { storageState, headers, cookies }; basic auth comes from AUTH_USERNAME / AUTH_PASSWORD
  accessibility: { enabled: true, tags: ['wcag2a', 'wcag2aa'], disableRules: [] }, // axe-core audit per page; tags pick the WCAG levels
  security: { enabled: true, headers: true, certWarnDays: 21 }, // security headers, mixed content, http->https redirect, TLS expiry
  userAgent: 'warden-qa-bot/0.1 (+https://github.com/lumiere042/warden)',
  // Screenshot diffs against a saved baseline (off by default). threshold: pixelmatch per-pixel; maxDiffPct: % of pixels.
  visual: { enabled: false, maxPages: 10, fullPage: false, threshold: 0.1, maxDiffPct: 1, viewport: { width: 1280, height: 800 } },
};

/**
 * Load qa.config.json (or the path given), apply defaults and CLI overrides.
 * If no config file exists, a site URL from --site or SITE_URL is enough to run.
 */
export function loadConfig({ configPath, siteOverride } = {}) {
  const file = path.resolve(configPath || 'qa.config.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err.message}`);
    }
  } else if (configPath) {
    throw new Error(`Config file not found: ${file}`);
  }

  const siteUrl = siteOverride || process.env.SITE_URL;
  let sites = raw.sites || [];
  if (siteUrl) {
    // --site / SITE_URL replaces the site list but keeps form config for a matching origin.
    const match = sites.find((s) => safeOrigin(s.url) === safeOrigin(siteUrl));
    sites = [{ ...(match || {}), url: siteUrl }];
  }
  if (!sites.length) {
    throw new Error(
      'No site to check. Create qa.config.json (see qa.config.example.json), or pass --site https://yoursite.com, or set SITE_URL.'
    );
  }

  const thresholds = { ...DEFAULTS.thresholds, ...(raw.thresholds || {}) };
  const exclude = [...new Set([...DEFAULTS.exclude, ...(raw.exclude || [])])];

  return {
    ...DEFAULTS,
    ...raw,
    thresholds,
    exclude,
    ignore: validateIgnore(raw.ignore ?? DEFAULTS.ignore),
    visual: { ...DEFAULTS.visual, ...(raw.visual || {}) },
    sites: sites.map((s) => {
      if (!s.url || !safeOrigin(s.url)) throw new Error(`Invalid site url: ${s.url}`);
      return {
        maxPages: raw.maxPages ?? DEFAULTS.maxPages,
        forms: [],
        ...s,
        url: s.url.replace(/\/+$/, '') || s.url,
      };
    }),
    email: {
      provider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
      from: process.env.EMAIL_FROM,
      to: (process.env.EMAIL_TO || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    },
    ai: resolveAi(raw.ai || {}),
    // Chat webhooks (URLs come from env). onlyOnIssues: stay quiet unless something is critical or new.
    notify: { onlyOnIssues: false, ...(raw.notify || {}) },
    formats: raw.formats || [],
  };
}

/**
 * Which AI writes the summary. Env vars win over the "ai" block in qa.config.json
 * (keys should only ever live in env / GitHub secrets).
 * With no AI_PROVIDER, the provider is inferred from whichever vendor key is set.
 */
function resolveAi(fileAi) {
  const env = process.env;
  const vendorKeys = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, gemini: env.GEMINI_API_KEY };
  const provider =
    (env.AI_PROVIDER || fileAi.provider || '').trim() ||
    Object.keys(vendorKeys).find((p) => vendorKeys[p]) ||
    null;
  const vendorKey = provider === 'openai-compatible' ? env.OPENAI_API_KEY : vendorKeys[provider];
  return {
    provider,
    apiKey: env.AI_API_KEY || vendorKey || null,
    model: env.AI_MODEL || fileAi.model || null,
    baseUrl: env.AI_BASE_URL || fileAi.baseUrl || null,
    promptFile: env.AI_PROMPT_FILE || fileAi.promptFile || null,
    maxTokens: Number(env.AI_MAX_TOKENS || fileAi.maxTokens || 16000),
  };
}

const IGNORE_FIELDS = ['check', 'key', 'page', 'match'];

/** Each ignore rule needs at least one of check / key / page / match (all strings), or it would hide everything. */
function validateIgnore(rules) {
  if (!Array.isArray(rules)) throw new Error('"ignore" in the config must be an array of rules');
  return rules.map((rule, n) => {
    const where = `ignore[${n}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where} must be an object, e.g. { "check": "meta", "key": "open-graph" }`);
    for (const [k, v] of Object.entries(rule)) {
      if (![...IGNORE_FIELDS, 'reason'].includes(k)) throw new Error(`${where}: unknown field "${k}" (use ${IGNORE_FIELDS.join(', ')}, reason)`);
      if (typeof v !== 'string') throw new Error(`${where}.${k} must be a string`);
    }
    if (!IGNORE_FIELDS.some((k) => rule[k])) throw new Error(`${where} would ignore every issue: give at least one of ${IGNORE_FIELDS.join(', ')}`);
    return rule;
  });
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
