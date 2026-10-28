// OpenAI Chat Completions API. Also works for any OpenAI-compatible server by setting
// AI_BASE_URL: Ollama (http://localhost:11434/v1), LM Studio, OpenRouter, Groq, Together, Azure, etc.

export const defaultModel = null; // must be set with AI_MODEL

export async function complete({ system, prompt, model, apiKey, baseUrl, maxTokens }) {
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      // api.openai.com wants max_completion_tokens; most compatible servers only know max_tokens.
      [baseUrl ? 'max_tokens' : 'max_completion_tokens']: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error?.message || res.statusText}`);
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty response');
  return text;
}
