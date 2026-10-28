import Anthropic from '@anthropic-ai/sdk';

// Models that accept server-side refusal fallbacks ("default" routing picks the fallback model).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const defaultModel = 'claude-opus-5-5';

export async function complete({ system, prompt, model, apiKey, baseUrl, maxTokens }) {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  const response = FALLBACK_MODELS.has(model) && !baseUrl
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);

  if (response.stop_reason === 'refusal') {
    throw new Error(`model declined (${response.stop_details?.category ?? 'no category'})`);
  }
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
