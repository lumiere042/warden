// Google Gemini API (generateContent).

export const defaultModel = null; // must be set with AI_MODEL

export async function complete({ system, prompt, model, apiKey, baseUrl, maxTokens }) {
  const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const res = await fetch(`${root}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error?.message || res.statusText}`);
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) throw new Error(`empty response (${body.candidates?.[0]?.finishReason || 'no candidates'})`);
  return text;
}
