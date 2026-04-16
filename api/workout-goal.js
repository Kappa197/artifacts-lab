function extractJsonPayload(text) {
  const src = String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();

  try {
    return JSON.parse(src);
  } catch {}

  const firstBrace = src.indexOf('{');
  const lastBrace = src.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(src.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = src.indexOf('[');
  const lastBracket = src.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return JSON.parse(src.slice(firstBracket, lastBracket + 1));
  }

  throw new Error('Gemini did not return valid JSON.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_WORKOUT_API;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_WORKOUT_API environment variable.' });
  }

  const prompt = String(req.body?.prompt || '').trim();
  const mode = String(req.body?.mode || 'plan').trim();

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt.' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: mode === 'intake' ? 0.15 : 0.2,
          },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }
    );

    const payload = await response.json();
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        `Gemini request failed (${response.status}).`;
      return res.status(response.status).json({ error: message });
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join('').trim() || '';
    if (!text) {
      return res.status(502).json({ error: 'Gemini returned an empty response.' });
    }

    const data = extractJsonPayload(text);
    return res.status(200).json({ ok: true, data, text });
  } catch (err) {
    return res.status(500).json({ error: `Workout goal proxy error: ${err.message}` });
  }
}
