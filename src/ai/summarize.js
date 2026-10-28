import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Built-in providers. To add your own, write a file that exports
// `async function complete({ system, prompt, model, apiKey, baseUrl, maxTokens })` returning text,
// and set AI_PROVIDER=./path/to/your-provider.js
const BUILT_IN = {
  anthropic: './providers/anthropic.js',
  openai: './providers/openai.js',
  'openai-compatible': './providers/openai.js',
  gemini: './providers/gemini.js',
};
const KEY_REQUIRED = new Set(['openai', 'gemini']);

/**
 * Optional AI summary of the night's findings. Never throws: if the AI isn't configured
 * or the call fails, the report goes out without it.
 * Returns { text, provider, model } or { skipped: reason }.
 */
export async function summarize(report, ai, log = () => {}) {
  if (!ai.provider) return { skipped: 'no AI provider configured' };
  if (ai.provider === 'none') return { skipped: 'AI disabled (AI_PROVIDER=none)' };

  try {
    const provider = await loadProvider(ai.provider);
    const model = ai.model || provider.defaultModel;
    if (!model) throw new Error(`set AI_MODEL for provider "${ai.provider}"`);
    // Custom adapters, local servers (AI_BASE_URL) and the Anthropic SDK's own credential lookup may not need a key here.
    if (KEY_REQUIRED.has(ai.provider) && !ai.apiKey && !ai.baseUrl) {
      throw new Error(`no API key for provider "${ai.provider}" (set AI_API_KEY)`);
    }

    log(`  AI summary via ${ai.provider} (${model})`);
    const text = await provider.complete({
      system: readPrompt(ai.promptFile),
      prompt: JSON.stringify(compact(report)),
      model,
      apiKey: ai.apiKey,
      baseUrl: ai.baseUrl,
      maxTokens: ai.maxTokens,
    });
    return { text: text.trim(), provider: BUILT_IN[ai.provider] ? ai.provider : path.basename(ai.provider), model };
  } catch (err) {
    log(`  AI summary skipped: ${err.message}`);
    return { skipped: `AI call failed: ${err.message}` };
  }
}

async function loadProvider(name) {
  const builtIn = BUILT_IN[name];
  const target = builtIn
    ? new URL(builtIn, import.meta.url).href
    : pathToFileURL(path.resolve(name)).href; // custom provider file
  if (!builtIn && !fs.existsSync(path.resolve(name))) {
    throw new Error(`unknown AI_PROVIDER "${name}" (use ${Object.keys(BUILT_IN).join(', ')}, none, or a path to a .js file)`);
  }
  const mod = await import(target);
  if (typeof mod.complete !== 'function') throw new Error(`${name} does not export a complete() function`);
  return mod;
}

function readPrompt(promptFile) {
  const file = promptFile ? path.resolve(promptFile) : path.join(here, '../../prompts/summary.md');
  return fs.readFileSync(file, 'utf8');
}

/** Keep the payload small: messages and paths, not raw page data. */
function compact(report) {
  return {
    generatedAt: report.generatedAt,
    sites: report.sites.map((s) => ({
      site: s.url,
      pagesCrawled: s.pagesCrawled,
      counts: s.counts,
      performance: s.performance,
      issues: s.issues.slice(0, 150).map((i) => ({
        check: i.check,
        severity: i.severity,
        page: i.page,
        message: i.message,
        new: i.isNew || undefined,
      })),
      fixedSinceLastRun: s.fixed.slice(0, 50).map((f) => f.message),
      untestedForms: s.untestedForms.length,
    })),
  };
}
