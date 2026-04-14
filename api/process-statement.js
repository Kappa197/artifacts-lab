// api/process-statement.js
// Vercel Edge Function — AI Statement Import + Receipt Scanning
// Uses Gemini 1.5 Pro via Google AI REST API
// Streaming keep-alive maintained via ReadableStream (Vercel Hobby compatible)

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://fvgajfiksxmwioxnesry.supabase.co';

// Gemini 1.5 Pro — SSE streaming endpoint
const GEMINI_MODEL   = 'gemini-1.5-pro';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

function toBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function statementPrompt(currency, categories) {
  const expLines = categories
    .filter(c => c.type !== 'income')
    .map(c => `  - ${c.name}  | bucket: ${c.bucket}`)
    .join('\n');
  const incLines = categories
    .filter(c => c.type === 'income')
    .map(c => `  - ${c.name}`)
    .join('\n');

  return `You are a financial data assistant helping to process a bank statement. The statement is in ${currency} from a bank account. It may include a header section with account details and a transaction table below.

Your task: extract every transaction and return a JSON array. Each object must have exactly these keys:
{"date":"copy exactly as shown in source","description":"copy original description exactly, do not translate","debit":<number or null>,"credit":<number or null>,"category":"exact name from list below"}

EXTRACTION RULES:
1. Include EVERY transaction row. Do not skip any row, including fees, transfers, and small amounts.
2. Ignore header rows, page numbers, running balance rows, and summary totals — these are not transactions.
3. debit: the amount when money LEFT the account (purchase, fee, withdrawal, transfer out). Use null if this is an incoming transaction.
4. credit: the amount when money ARRIVED in the account (salary, refund, deposit, transfer in). Use null if this is an outgoing transaction.
5. Amounts: plain numbers only, period as decimal separator. No currency symbols, no commas. Example: 1250.50
6. Do not convert amounts — currency is ${currency}.

CATEGORIZATION RULES:
7. Use your knowledge of merchants, brands, apps, and services worldwide (including Thai businesses) to assign the best matching category.
8. Consider the full description — app names, merchant codes, and partial names are all useful clues.
9. Assign categories from EXPENSE CATEGORIES for debit transactions, and INCOME CATEGORIES for credit transactions.
10. Write ONLY the category name — do not include the bucket label in parentheses.
11. If you genuinely cannot determine the category after considering the description, write: Uncategorized

OUTPUT:
- Output ONLY the raw JSON array. No introduction, no explanation, no markdown, no code blocks.
- The very first character of your response must be [ and the last must be ]

EXPENSE CATEGORIES:
${expLines}

INCOME CATEGORIES:
${incLines}`;
}

function receiptPrompt(currency, categories) {
  const expLines = categories
    .filter(c => c.type !== 'income')
    .map(c => `  - ${c.name}  | bucket: ${c.bucket}`)
    .join('\n');

  return `Extract key details from this receipt image and return a single JSON object.

OUTPUT FORMAT:
{"date":"YYYY-MM-DD if readable, otherwise null","merchant":"store or restaurant name","amount":<total amount as number>,"description":"merchant name and brief context e.g. Starbucks Siam - coffee","category":"exact name from list below"}

RULES:
1. amount: the TOTAL charged (after tax, final amount). Plain number, period as decimal. Example: 245.00
2. Currency is ${currency}. Do not convert amounts.
3. category: use your knowledge of the merchant to assign the best matching category from the list below. Write ONLY the category name.
4. If you cannot determine the category, write: Uncategorized
5. OUTPUT ONLY the raw JSON object. No markdown, no explanation. Start with {

EXPENSE CATEGORIES:
${expLines}`;
}

// ─── Supabase auth ────────────────────────────────────────────────────────────

async function verifyAuth(req) {
  const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  if (!SUPABASE_ANON) { console.warn('SUPABASE_ANON_KEY not set — skipping auth'); return true; }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': auth, 'apikey': SUPABASE_ANON },
  });
  return res.ok;
}

// ─── JSON extraction (robust multi-fallback) ──────────────────────────────────

function extractJSON(text, mode) {
  if (!text) throw new Error('Empty response from AI');

  // Strip all markdown code fences (Gemini occasionally wraps output)
  text = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();

  // Fast path — clean JSON
  try { return JSON.parse(text); } catch {}

  // Extract outermost array (statement mode)
  if (mode !== 'receipt') {
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s !== -1 && e > s) {
      try { return JSON.parse(text.slice(s, e + 1)); } catch {}
      try {
        const cleaned = text.slice(s, e + 1)
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        return JSON.parse(cleaned);
      } catch {}
    }
  }

  // Extract outermost object (receipt mode or fallback)
  const os = text.indexOf('{'), oe = text.lastIndexOf('}');
  if (os !== -1 && oe > os) {
    try { return JSON.parse(text.slice(os, oe + 1)); } catch {}
    try {
      const cleaned = text.slice(os, oe + 1)
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
      return JSON.parse(cleaned);
    } catch {}
  }

  throw new Error('Response was not valid JSON — the AI may have returned an unexpected format');
}

// ─── Gemini API call ──────────────────────────────────────────────────────────
// Gemini request format:
//   { contents: [{ role: 'user', parts: [...] }], generationConfig: {...} }
// Parts can be: { text: '...' } or { inlineData: { mimeType, data } }
// Response (SSE): each `data:` line is a JSON chunk with candidates[].content.parts[].text

async function callGemini(parts, apiKey) {
  const url = `${GEMINI_API_URL}&key=${apiKey}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature:     0,    // deterministic — best for structured data extraction
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[process-statement] Gemini error', res.status, errText.slice(0, 300));
    if (res.status === 400) throw new Error('Invalid request — the file may be corrupted or in an unsupported format.');
    if (res.status === 401 || res.status === 403) throw new Error('AI service authentication failed. Check GEMINI_API_KEY in Vercel environment variables.');
    if (res.status === 429) throw new Error('AI service rate limit reached. Please wait a moment and try again.');
    throw new Error(`AI service error (${res.status}). Please try again.`);
  }

  // Read SSE stream and accumulate all text parts
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText    = '';
  let buffer      = '';
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk     = JSON.parse(payload);
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of (candidate.content?.parts || [])) {
          if (part.text) fullText += part.text;
        }

        // MAX_TOKENS = response was cut off mid-JSON
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
          finishReason = candidate.finishReason;
        }
      } catch {}
    }
  }

  if (finishReason === 'MAX_TOKENS') {
    throw new Error('The statement is too large for a single AI call. Try splitting it into smaller date ranges (e.g. one month at a time).');
  }

  if (!fullText) throw new Error('Empty response from AI — the file may be unreadable or blank.');

  return fullText;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req) {
  try {
    return await processRequest(req);
  } catch (e) {
    console.error('[process-statement] Unhandled error:', e?.message || e);
    return jsonResponse({ error: 'Unexpected server error: ' + (e?.message || 'unknown') }, 500);
  }
}

async function processRequest(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'Method not allowed' }, 405);

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return jsonResponse({ error: 'Server configuration error: missing GEMINI_API_KEY.' }, 500);

  const authed = await verifyAuth(req);
  if (!authed) return jsonResponse({ error: 'Unauthorized. Please log in and try again.' }, 401);

  let formData;
  try { formData = await req.formData(); }
  catch (e) { return jsonResponse({ error: 'Could not parse request: ' + e.message }, 400); }

  const mode       = formData.get('mode') || 'statement';
  const currency   = formData.get('currency') || 'THB';
  const file       = formData.get('file');
  const catsRaw    = formData.get('categories');
  const categories = catsRaw ? JSON.parse(catsRaw) : [];

  if (!file) return jsonResponse({ error: 'No file provided.' }, 400);

  // ── Build Gemini parts array ───────────────────────────────────────────────
  // Gemini 1.5 Pro supports PDF, images, and text natively via inlineData.
  // No separate document-block API needed — everything is inlineData or text.

  const parts    = [];
  const fileType = file.type || 'application/octet-stream';

  if (fileType === 'application/pdf') {
    // Gemini 1.5 Pro reads PDFs natively (both searchable and scanned)
    const bytes = await file.arrayBuffer();
    parts.push({ inlineData: { mimeType: 'application/pdf', data: toBase64(bytes) } });

  } else if (fileType.startsWith('image/')) {
    const validMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(fileType)
      ? fileType : 'image/jpeg';
    const bytes = await file.arrayBuffer();
    parts.push({ inlineData: { mimeType: validMime, data: toBase64(bytes) } });

  } else {
    // Plain text / CSV / PDF text extracted client-side by PDF.js
    const text = await file.text();
    if (!text.trim()) return jsonResponse({ error: 'The file appears to be empty.' }, 400);
    parts.push({ text: `Bank statement (${file.name}):\n\n${text}` });
  }

  // Prompt is always the final text part in the same user turn
  parts.push({
    text: mode === 'receipt'
      ? receiptPrompt(currency, categories)
      : statementPrompt(currency, categories),
  });

  // ── Stream Gemini response back to client ──────────────────────────────────
  // Wrapped in ReadableStream so Vercel keeps the connection open
  // while Gemini processes (same pattern as the previous Anthropic version).

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const rawText = await callGemini(parts, GEMINI_KEY);
        console.log('[process-statement] Gemini raw (first 200):', rawText.slice(0, 200));

        const data   = extractJSON(rawText, mode);
        const result = JSON.stringify({ ok: true, data, mode });
        controller.enqueue(new TextEncoder().encode(result));
        controller.close();

      } catch (e) {
        console.error('[process-statement] Error:', e.message);
        const errResult = JSON.stringify({ error: e.message });
        controller.enqueue(new TextEncoder().encode(errResult));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
