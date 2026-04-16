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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function normalizeModelName(modelName) {
  const m = String(modelName || '').trim();
  if (!m) return '';
  return m.startsWith('models/') ? m : `models/${m}`;
}

async function getAvailableGeminiModels(apiKey) {
  const url = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    // If listing fails, we still return [] so caller can fall back to a safe default list.
    return [];
  }
  const payload = await res.json();
  const models = payload?.models || [];
  return models
    .filter(m => (m?.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name)
    .filter(Boolean);
}

function buildModelPreferenceList(requestedModel, availableModels) {
  const preferredShort = [
    requestedModel || '',
    // Stable, generally available newer models
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    // Older ones (kept only as fallback; may be absent from availableModels)
    'gemini-2.0-pro',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ].filter(Boolean);

  // If we have availableModels, only try those.
  if (Array.isArray(availableModels) && availableModels.length) {
    const available = new Set(availableModels);
    const shortToFull = {};
    for (const full of availableModels) {
      const short = full.replace(/^models\//, '');
      shortToFull[short] = full;
    }

    const prioritized = [];
    for (const pref of preferredShort) {
      const nFull = normalizeModelName(pref);
      if (available.has(nFull)) prioritized.push(nFull);
      if (shortToFull[pref]) prioritized.push(shortToFull[pref]);
    }

    for (const full of availableModels) {
      if (/gemini/i.test(full)) prioritized.push(full);
    }
    return [...new Set(prioritized)];
  }

  // If listing fails, return the short list as-is (best-effort).
  return [...new Set(preferredShort.map(normalizeModelName))];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchGeminiWithRetry(url, payload, model, retries = 2) {
  let lastRes = null;
  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastRes = res;
      if (res.ok) return res;
      if (!isRetriableStatus(res.status) || i === retries - 1) return res;
      await sleep(Math.pow(2, i) * 1000);
    } catch (e) {
      lastErr = e;
      if (i === retries - 1) break;
      await sleep(Math.pow(2, i) * 1000);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error('Network error while contacting AI service.');
}

async function callGemini(parts, apiKey, requestedModel, temperature) {
  const availableModels = await getAvailableGeminiModels(apiKey);
  const models = buildModelPreferenceList(requestedModel, availableModels);

  if (!models.length) {
    throw new Error('No Gemini models available for this API key/project.');
  }

  let lastStatus = null;
  let lastBody = '';

  for (const model of models) {
    const modelPath = normalizeModelName(model);
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelPath.replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const requestPayload = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature,
      },
    };

    const res = await fetchGeminiWithRetry(url, requestPayload, model, 2);
    if (!res.ok) {
      lastStatus = res.status;
      lastBody = await res.text();

      // Try next model on "model not found/unavailable" style errors.
      if (res.status === 404 || res.status === 400 || res.status === 403) continue;
      throw new Error(`Gemini request failed (${res.status}).`);
    }

    const payload = await res.json();
    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map(part => part?.text || '')
      .join('')
      .trim();

    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }

  if (lastBody) {
    return extractJsonPayload(lastBody);
  }
  throw new Error(`Gemini request failed (${lastStatus || 'unknown'}).`);
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
  const requestedModel = String(req.body?.model || '').trim();

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt.' });
  }

  try {
    const temperature = mode === 'intake' ? 0.15 : 0.2;
    const effectiveRequestedModel =
      requestedModel || (mode === 'intake' ? 'gemini-2.5-flash' : 'gemini-2.5-pro');

    const text = await callGemini([{ text: prompt }], apiKey, effectiveRequestedModel, temperature);
    const data = extractJsonPayload(text);
    return res.status(200).json({ ok: true, data, text });
  } catch (err) {
    return res.status(500).json({ error: `Workout goal proxy error: ${err.message}` });
  }
}
