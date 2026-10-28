import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  maxPages: 50,
  thresholds: { loadMs: 3000, lcpMs: 2500, pageWeightKb: 3000 },
  checkExternalLinks: true,
  exclude: ['mailto:', 'tel:', 'javascript:'],
  concurrency: 8,
  timeoutMs: 10000,
  userAgent: 'website-qa-bot/0.1 (+https://github.com/)',
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

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
