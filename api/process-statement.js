// api/process-statement.js
// Vercel Edge Function — AI Statement Import + Receipt Scanning

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://fvgajfiksxmwioxnesry.supabase.co';

// Safe base64 encoding for Edge runtime (avoids stack overflow on large files)
function toBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function statementPrompt(categories, currency) {
  const expLines = categories
    .filter(c => c.type !== 'income')
    .map(c => `  - ${c.name}  | bucket: ${c.bucket}`)
    .join('\n');
  const incLines = categories
    .filter(c => c.type === 'income')
    .map(c => `  - ${c.name}`)
    .join('\n');

  return `You are a financial data assistant. Convert the attached bank statement into a JSON array.

OUTPUT FORMAT — a JSON array, each object with exactly these keys:
{
  "date": "copy the date exactly as it appears in the source",
  "description": "copy the transaction description exactly, do not translate",
  "debit": <number or null>,
  "credit": <number or null>,
  "category": "exact category name from the list below"
}

RULES:
1. Include EVERY transaction. Do not skip any row.
2. debit: amount when money LEFT the account. null if incoming.
3. credit: amount when money ARRIVED. null if outgoing.
4. Amounts: plain numbers only. Period as decimal. Example: 1250.50
5. Currency is ${currency}. Do not convert.
6. category: ONLY names from the lists below. Write ONLY the category name — no bucket label.
7. For credit transactions use INCOME CATEGORIES.
8. If unsure, write: Uncategorized
9. OUTPUT ONLY the raw JSON array. No explanation, no markdown. Start with [

EXPENSE CATEGORIES:
${expLines}

INCOME CATEGORIES:
${incLines}

Your entire response must be the JSON array only, starting with [ and ending with ]`;
}

function receiptPrompt(currency) {
  return `Extract key details from this receipt image.

OUTPUT FORMAT — a single JSON object:
{
  "date": "YYYY-MM-DD if readable, otherwise null",
  "merchant": "store or merchant name",
  "amount": <total amount as a number>,
  "description": "merchant name and brief context"
}

RULES:
1. amount: the TOTAL charged. Plain number, period as decimal.
2. Currency is ${currency}. Do not convert.
3. OUTPUT ONLY the raw JSON object. No markdown. Start with {`;
}

export default async function handler(req) {
  // Outer safety net — ensures we always return JSON even on unexpected crashes
  try {
    return await processRequest(req);
  } catch (e) {
    console.error('[process-statement] Unhandled error:', e?.message || e);
    return jsonResponse({ error: 'Unexpected server error: ' + (e?.message || 'unknown') }, 500);
  }
}

async function processRequest(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Read env vars inside the request handler (more reliable in Edge runtime)
  const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_KEY) {
    console.error('[process-statement] ANTHROPIC_API_KEY is not set');
    return jsonResponse({ error: 'Server configuration error: missing API key.' }, 500);
  }

  // Verify auth
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing or invalid Authorization header.' }, 401);
  }

  const token = authHeader.slice(7);

  if (SUPABASE_ANON) {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON,
      },
    });
    if (!userRes.ok) {
      return jsonResponse({ error: 'Unauthorized. Please log in and try again.' }, 401);
    }
  } else {
    console.warn('[process-statement] SUPABASE_ANON_KEY not set — skipping auth check');
  }

  // Parse form data
  let formData;
  try {
    formData = await req.formData();
  } catch (e) {
    return jsonResponse({ error: 'Could not parse request body: ' + e.message }, 400);
  }

  const mode       = formData.get('mode') || 'statement';
  const currency   = formData.get('currency') || 'THB';
  const file       = formData.get('file');
  const catsRaw    = formData.get('categories');
  const categories = catsRaw ? JSON.parse(catsRaw) : [];

  if (!file) return jsonResponse({ error: 'No file provided.' }, 400);

  // Build Claude message content
  const content  = [];
  const fileType = file.type || 'application/octet-stream';

  if (fileType === 'application/pdf') {
    const bytes = await file.arrayBuffer();
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) },
    });
  } else if (fileType.startsWith('image/')) {
    const validType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(fileType)
      ? fileType : 'image/jpeg';
    const bytes = await file.arrayBuffer();
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: validType, data: toBase64(bytes) },
    });
  } else {
    // CSV or text
    const text = await file.text();
    if (!text.trim()) return jsonResponse({ error: 'The file appears to be empty.' }, 400);
    content.push({ type: 'text', text: `Bank statement (${file.name}):\n\n${text}` });
  }

  content.push({
    type: 'text',
    text: mode === 'receipt' ? receiptPrompt(currency) : statementPrompt(categories, currency),
  });

  // Call Claude API
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages:   [{ role: 'user', content }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error('[process-statement] Claude API error', claudeRes.status, errText.slice(0, 200));
    return jsonResponse({
      error: `AI service error (${claudeRes.status}). ${claudeRes.status === 401 ? 'Check your API key.' : 'Please try again.'}`,
    }, 502);
  }

  const claudeData = await claudeRes.json();
  const rawText    = claudeData.content?.[0]?.text || '';

  // Parse JSON from Claude's response — robust extraction handles extra text + Thai chars
  try {
    const data = extractJSON(rawText, mode);
    return jsonResponse({ ok: true, data, mode });
  } catch (e) {
    console.error('[process-statement] JSON parse error:', e.message);
    console.error('[process-statement] Raw (first 400):', rawText.slice(0, 400));
    return jsonResponse({
      error: 'Could not parse AI response. Details: ' + e.message,
    }, 500);
  }
}

// Robustly extract JSON from Claude's response even if it adds surrounding text
function extractJSON(text, mode) {
  if (!text) throw new Error('Empty response from AI');

  // 1. Strip markdown code fences
  text = text.replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```$/im, '').trim();

  // 2. Try direct parse first
  try { return JSON.parse(text); } catch {}

  // 3. For statement mode: find the outermost JSON array
  if (mode !== 'receipt') {
    const start = text.indexOf('[');
    const end   = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }

  // 4. For receipt mode (or fallback): find the outermost JSON object
  const oStart = text.indexOf('{');
  const oEnd   = text.lastIndexOf('}');
  if (oStart !== -1 && oEnd > oStart) {
    try { return JSON.parse(text.slice(oStart, oEnd + 1)); } catch {}
  }

  // 5. Last resort: try to fix common JSON issues (Thai/special chars in strings)
  try {
    const fixed = text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // remove control chars
      .replace(/,\s*([}\]])/g, '$1');                                  // trailing commas
    return JSON.parse(fixed);
  } catch {}

  throw new Error('Response was not valid JSON — Claude may have added explanation text');
}
