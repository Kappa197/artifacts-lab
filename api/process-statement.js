// api/process-statement.js
// Vercel Edge Function — AI Statement Import + Receipt Scanning
// Uses Gemini 1.5 Pro via Google AI REST API
// Streaming keep-alive maintained via ReadableStream (Vercel Hobby compatible)

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://fvgajfiksxmwioxnesry.supabase.co';

// Gemini API endpoint (non-streaming is more stable across models on Vercel Edge)
const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash'; // high-availability default
const GEMINI_PRO_MODEL = 'gemini-2.0-pro';       // stable for complex tables
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

  return `STRICT RULE: Output ONLY valid JSON. Do not include headers, balance columns, address/account info, or any explanation. Keep descriptions <= 40 chars.

You are a financial data assistant helping to process a bank statement. The statement is in ${currency} from a bank account. It may include a header section with account details and a transaction table below.

Your task: extract every transaction and return a JSON array using this COMPACT schema:
{"d":"date exactly as shown","s":"short description","dr":<number or null>,"cr":<number or null>,"c":"exact category name from list below"}

EXTRACTION RULES:
1. Include EVERY transaction row. Do not skip any row, including fees, transfers, and small amounts. Keep "s" concise (max 25 chars), prioritizing merchant name and city.
2. Ignore header rows, page numbers, running balance rows, and summary totals — these are not transactions.
3. debit: the amount when money LEFT the account (purchase, fee, withdrawal, transfer out). Use null if this is an incoming transaction.
4. credit: the amount when money ARRIVED in the account (salary, refund, deposit, transfer in). Use null if this is an outgoing transaction.
5. Amounts: plain numbers only, period as decimal separator. No currency symbols, no commas. Example: 1250.50
6. Do not convert amounts — currency is ${currency}.

CATEGORIZATION RULES:
7. Use your knowledge of merchants, brands, apps, and services worldwide (including Thai businesses) to assign the best matching category.
8. Consider the full description — app names, merchant codes, and partial names are all useful clues.
9. Assign categories from EXPENSE CATEGORIES for debit transactions, and INCOME CATEGORIES for credit transactions.
10. Write ONLY the category name in "c" — do not include the bucket label in parentheses.
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
// Response: JSON with candidates[].content.parts[].text

function normalizeModelName(modelName) {
  const m = String(modelName || '').trim();
  if (!m) return '';
  return m.startsWith('models/') ? m : `models/${m}`;
}

async function getAvailableGeminiModels(apiKey) {
  const url = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    console.error('[process-statement] Could not list Gemini models', res.status, errText.slice(0, 300));
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
  const available = new Set(availableModels);
  const shortToFull = {};
  for (const full of availableModels) {
    const short = full.replace(/^models\//, '');
    shortToFull[short] = full;
  }

  const preferredShort = [
    GEMINI_DEFAULT_MODEL,
    GEMINI_PRO_MODEL,
    requestedModel || '',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ].filter(Boolean);

  const prioritized = [];
  for (const pref of preferredShort) {
    const nFull = normalizeModelName(pref);
    if (available.has(nFull)) prioritized.push(nFull);
    if (shortToFull[pref]) prioritized.push(shortToFull[pref]);
    const latestAlias = `${pref}-latest`;
    if (shortToFull[latestAlias]) prioritized.push(shortToFull[latestAlias]);
  }

  for (const full of availableModels) {
    if (/gemini/i.test(full)) prioritized.push(full);
  }

  return [...new Set(prioritized)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isModelInputMismatch400(errText) {
  const t = String(errText || '').toLowerCase();
  return (
    t.includes('unsupported') ||
    t.includes('not supported') ||
    t.includes('mime') ||
    t.includes('modality') ||
    t.includes('inline_data') ||
    t.includes('inline data') ||
    t.includes('file type') ||
    t.includes('application/pdf')
  );
}

async function fetchGeminiWithRetry(url, payload, model, retries = 3) {
  let lastRes = null;
  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastRes = res;

      if (res.ok) return res;
      if (!isRetriableStatus(res.status) || i === retries - 1) return res;

      const wait = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      console.warn(`[process-statement] transient ${res.status} on ${model}; retrying in ${wait}ms`);
      await sleep(wait);
    } catch (e) {
      lastErr = e;
      if (i === retries - 1) break;
      const wait = Math.pow(2, i) * 1000;
      console.warn(`[process-statement] network error on ${model}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error('Network error while contacting AI service.');
}

function splitStatementTextIntoChunks(text, maxChars = 120000) {
  const src = String(text || '');
  if (!src.trim()) return [];

  // Primary strategy: split by lines (best for tabular statements)
  const lines = src.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);

  // Fallback strategy: OCR/searchable-PDF text can arrive as one giant line.
  if (chunks.length <= 1 && src.length > maxChars) {
    const charChunks = [];
    for (let i = 0; i < src.length; i += maxChars) {
      const end = Math.min(i + maxChars, src.length);
      charChunks.push(src.slice(i, end));
    }
    return charChunks;
  }
  return chunks;
}

function normalizeStatementRows(data) {
  if (!Array.isArray(data)) data = [data];
  return data.map((row) => {
    if (!row || typeof row !== 'object') return row;
    return {
      date: row.date ?? row.d ?? null,
      description: row.description ?? row.s ?? '',
      debit: row.debit ?? row.dr ?? null,
      credit: row.credit ?? row.cr ?? null,
      category: row.category ?? row.c ?? 'Uncategorized',
    };
  });
}

function makeRowFingerprint(row) {
  const d = String(row?.date ?? '').trim();
  const s = String(row?.description ?? '').trim().toLowerCase();
  const dr = row?.debit == null ? '' : String(row.debit);
  const cr = row?.credit == null ? '' : String(row.credit);
  return `${d}|${s}|${dr}|${cr}`;
}

function buildStatementPagePrompt(currency, categories, alreadySeenCompactRows, pageNum, pageSize) {
  const base = statementPrompt(currency, categories);
  const seenList = (alreadySeenCompactRows || [])
    .slice(-250)
    .map(r => `- d:${r.d || ''} | s:${r.s || ''} | dr:${r.dr ?? ''} | cr:${r.cr ?? ''}`)
    .join('\n');

  return `${base}

PAGED EXTRACTION MODE:
- This is extraction pass ${pageNum}.
- Return AT MOST ${pageSize} transactions in this pass.
- Skip transactions already returned in previous passes.
- If no more transactions remain, return rows: [] and hasMore: false.

ALREADY RETURNED TRANSACTIONS (DO NOT REPEAT):
${seenList || '- (none)'}

OUTPUT FORMAT (ONLY this JSON object, no markdown):
{"rows":[{"d":"...","s":"...","dr":null,"cr":123.45,"c":"..."}],"hasMore":true}`;
}

function extractStatementPagePayload(rawText) {
  const parsed = extractJSON(rawText, 'statement');
  if (Array.isArray(parsed)) return { rows: parsed, hasMore: false };
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const hasMore = !!parsed?.hasMore;
  return { rows, hasMore };
}

function splitChunkInHalf(text) {
  const src = String(text || '');
  const lines = src.split('\n');
  if (lines.length <= 1) {
    const mid = Math.floor(src.length / 2);
    if (mid <= 0 || mid >= src.length) return [src, ''];
    return [src.slice(0, mid), src.slice(mid)];
  }
  const mid = Math.floor(lines.length / 2);
  const left = lines.slice(0, mid).join('\n');
  const right = lines.slice(mid).join('\n');
  return [left, right];
}

async function callGemini(parts, apiKey, requestedModel) {
  const availableModels = await getAvailableGeminiModels(apiKey);
  const models = buildModelPreferenceList(requestedModel, availableModels);

  let lastStatus = null;
  let lastBody = '';

  for (const model of models) {
    const modelPath = normalizeModelName(model);
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(modelPath.replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const requestPayload = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: 32768,
        temperature: 0,
        responseMimeType: 'application/json',
      },
    };

    const res = await fetchGeminiWithRetry(url, requestPayload, model, 3);

    if (!res.ok) {
      const errText = await res.text();
      lastStatus = res.status;
      lastBody = errText;
      console.error(`[process-statement] Gemini error on model ${model}`, res.status, errText.slice(0, 300));
      // Try next model on not found (model/endpoint mismatch)
      if (res.status === 404) continue;
      // Some models do not accept some input types (e.g. PDF inlineData) -> try next model
      if (res.status === 400 && isModelInputMismatch400(errText)) continue;
      if (res.status === 503 || res.status === 502 || res.status === 504) continue;
      if (res.status === 400) throw new Error('Invalid request — the file may be corrupted or in an unsupported format.');
      if (res.status === 401 || res.status === 403) throw new Error('AI service authentication failed. Check GEMINI_API_KEY in Vercel environment variables.');
      if (res.status === 429) throw new Error('AI service rate limit reached. Please wait a moment and try again.');
      throw new Error(`AI service error (${res.status}). Please try again.`);
    }

    const payload = await res.json();
    const candidate = payload?.candidates?.[0];
    const finishReason = candidate?.finishReason || null;
    const fullText = (candidate?.content?.parts || []).map(p => p?.text || '').join('').trim();

    if (finishReason === 'MAX_TOKENS') {
      console.warn('[process-statement] MAX_TOKENS reached; attempting to parse partial response.');
    }
    if (!fullText) {
      const blockedReason = payload?.promptFeedback?.blockReason;
      if (blockedReason) throw new Error(`AI response was blocked: ${blockedReason}.`);
      throw new Error('Empty response from AI — the file may be unreadable or blank.');
    }
    return fullText;
  }

  if (!models.length) {
    throw new Error('No Gemini models with generateContent are enabled for this API key/project.');
  }
  if (lastStatus === 404) {
    console.error('[process-statement] All model fallbacks returned 404:', lastBody.slice(0, 300));
    throw new Error('AI service model not found (404). Check available Gemini models for your API key/project.');
  }
  if (lastStatus === 400 && isModelInputMismatch400(lastBody)) {
    throw new Error('AI service rejected this file type on available models. Please try converting the statement to text/CSV and retry.');
  }
  throw new Error(`AI service error (${lastStatus || 'unknown'}). Please try again.`);
}

async function callGeminiForStatementWithAutoChunking(fileName, statementText, currency, categories, apiKey, model) {
  const singleParts = [
    { text: `Bank statement (${fileName}):\n\n${statementText}` },
    { text: statementPrompt(currency, categories) },
  ];

  try {
    const rawText = await callGemini(singleParts, apiKey, model);
    return extractJSON(rawText, 'statement');
  } catch (e) {
    if (e?.code !== 'MAX_TOKENS') throw e;
  }

  const chunks = splitStatementTextIntoChunks(statementText, 30000);
  if (chunks.length <= 1) {
    throw new Error('The statement is too large for a single AI call. Try splitting it into smaller date ranges (e.g. one month at a time).');
  }

  async function extractChunk(chunkText, i, total, depth = 0) {
    const chunkPrompt = `${statementPrompt(currency, categories)}

IMPORTANT FOR CHUNKED EXTRACTION:
- This is chunk ${i + 1} of ${chunks.length} from one statement.
- Extract ONLY transactions visible in this chunk.
- Keep original dates/descriptions exactly as shown.
- Return ONLY a JSON array.`;

    const chunkParts = [
      { text: `Bank statement (${fileName}) [chunk ${i + 1}/${total}, split-depth ${depth}]:\n\n${chunkText}` },
      { text: chunkPrompt },
    ];

    try {
      const rawChunk = await callGemini(chunkParts, apiKey, model);
      const parsed = extractJSON(rawChunk, 'statement');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      if (e?.code !== 'MAX_TOKENS') throw e;
      if (depth >= 4) {
        throw new Error('The statement is too large for automatic chunk processing. Please split it into smaller date ranges (e.g. one month at a time).');
      }
      const [left, right] = splitChunkInHalf(chunkText);
      if (!left.trim() || !right.trim()) {
        throw new Error('The statement is too large for automatic chunk processing. Please split it into smaller date ranges (e.g. one month at a time).');
      }
      const leftRows = await extractChunk(left, i, total * 2, depth + 1);
      const rightRows = await extractChunk(right, i, total * 2, depth + 1);
      return [...leftRows, ...rightRows];
    }
  }

  const allRows = [];
  for (let i = 0; i < chunks.length; i++) {
    const rows = await extractChunk(chunks[i], i, chunks.length, 0);
    allRows.push(...rows);
  }

  return allRows;
}

async function callGeminiForStatementPaged(sourceParts, currency, categories, apiKey, model) {
  const allCompactRows = [];
  const seen = new Set();
  let pageSize = 35;

  for (let page = 1; page <= 8; page++) {
    const pagePrompt = buildStatementPagePrompt(currency, categories, allCompactRows, page, pageSize);
    const parts = [...sourceParts, { text: pagePrompt }];
    let rawText;
    try {
      rawText = await callGemini(parts, apiKey, model);
    } catch (e) {
      if (e?.code === 'MAX_TOKENS' && pageSize > 10) {
        pageSize = Math.max(10, Math.floor(pageSize / 2));
        page--;
        continue;
      }
      throw e;
    }
    const { rows, hasMore } = extractStatementPagePayload(rawText);

    let newRows = 0;
    for (const row of (rows || [])) {
      const normalized = normalizeStatementRows([row])[0];
      const key = makeRowFingerprint(normalized);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allCompactRows.push(row);
      newRows++;
    }

    if (!hasMore) break;
    if (newRows === 0) break;
  }

  return allCompactRows;
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
  const model      = formData.get('model') || GEMINI_DEFAULT_MODEL;
  const effectiveModel = model;
  const categories = catsRaw ? JSON.parse(catsRaw) : [];

  if (!file) return jsonResponse({ error: 'No file provided.' }, 400);

  // ── Build Gemini parts array ───────────────────────────────────────────────
  // Gemini 1.5 Pro supports PDF, images, and text natively via inlineData.
  // No separate document-block API needed — everything is inlineData or text.

  const sourceParts = [];
  const fileType = file.type || 'application/octet-stream';
  let statementText = '';

  if (fileType === 'application/pdf') {
    // Gemini 1.5 Pro reads PDFs natively (both searchable and scanned)
    const bytes = await file.arrayBuffer();
    sourceParts.push({ inlineData: { mimeType: 'application/pdf', data: toBase64(bytes) } });

  } else if (fileType.startsWith('image/')) {
    const validMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(fileType)
      ? fileType : 'image/jpeg';
    const bytes = await file.arrayBuffer();
    sourceParts.push({ inlineData: { mimeType: validMime, data: toBase64(bytes) } });

  } else {
    // Plain text / CSV / PDF text extracted client-side by PDF.js
    statementText = await file.text();
    if (!statementText.trim()) return jsonResponse({ error: 'The file appears to be empty.' }, 400);
    sourceParts.push({ text: `Bank statement (${file.name}):\n\n${statementText}` });
  }

  // Prompt is always the final text part in the same user turn
  const parts = [...sourceParts, {
    text: mode === 'receipt'
      ? receiptPrompt(currency, categories)
      : statementPrompt(currency, categories),
  }];

  // ── Stream Gemini response back to client ──────────────────────────────────
  // Wrapped in ReadableStream so Vercel keeps the connection open
  // while Gemini processes (same pattern as the previous Anthropic version).

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let data;
        if (mode === 'statement' && statementText) {
          const parsed = await callGeminiForStatementWithAutoChunking(
            file.name,
            statementText,
            currency,
            categories,
            GEMINI_KEY,
            effectiveModel
          );
          data = normalizeStatementRows(parsed);
        } else if (mode === 'statement') {
          const parsed = await callGeminiForStatementPaged(
            sourceParts,
            currency,
            categories,
            GEMINI_KEY,
            effectiveModel
          );
          data = normalizeStatementRows(parsed);
        } else {
          const rawText = await callGemini(parts, GEMINI_KEY, effectiveModel);
          console.log('[process-statement] Gemini raw (first 200):', rawText.slice(0, 200));
          const parsed = extractJSON(rawText, mode);
          data = mode === 'statement' ? normalizeStatementRows(parsed) : parsed;
        }

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
