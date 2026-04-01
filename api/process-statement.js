// api/process-statement.js
// Vercel Edge Function — AI Statement Import + Receipt Scanning
// Handles: PDF bank statements, CSV/text statements, receipt images
// Called by the Finance Tracker tool (basic/premium tiers)

export const config = { runtime: 'edge' };

const SUPABASE_URL    = 'https://fvgajfiksxmwioxnesry.supabase.co';
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

// ── Safe base64 for Edge runtime (avoids stack overflow on large files) ───────
function toBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Prompts ───────────────────────────────────────────────────────────────────
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

RULES — follow every one:
1. Include EVERY transaction. Do not skip any row.
2. debit: the amount when money LEFT the account (purchase, fee, transfer out). null if incoming.
3. credit: the amount when money ARRIVED (salary, refund, transfer in). null if outgoing.
4. Amounts: plain numbers only. No currency symbols. Period as decimal separator. Example: 1250.50
5. Currency is ${currency}. Do not convert amounts.
6. category: assign exactly one name from the lists below. Use your knowledge to identify merchants and services. Write ONLY the category name — no bucket label.
7. For credit transactions use the INCOME CATEGORIES list.
8. If you cannot determine the category, write: Uncategorized
9. OUTPUT ONLY the raw JSON array. No explanation, no markdown, no code blocks. The first character must be [

EXPENSE CATEGORIES:
${expLines}

INCOME CATEGORIES:
${incLines}

IMPORTANT: Your entire response must be the JSON array only, starting with [ and ending with ]`;
}

function receiptPrompt(currency) {
  return `You are a receipt scanning assistant. Extract the key details from this receipt image.

OUTPUT FORMAT — a single JSON object with exactly these keys:
{
  "date": "YYYY-MM-DD if readable, otherwise null",
  "merchant": "the store or merchant name",
  "amount": <total amount paid as a number>,
  "description": "merchant name and brief context, e.g. Starbucks Siam - coffee"
}

RULES:
1. amount: the TOTAL charged (final amount, not subtotal before tax). Plain number, period as decimal.
2. Currency is ${currency}. Do not convert amounts.
3. If the date is not readable, use null.
4. OUTPUT ONLY the raw JSON object. No markdown. Start with {`;
}

// ── Auth: verify Supabase JWT ─────────────────────────────────────────────────
async function verifyAuth(req) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  // 1. Auth
  const user = await verifyAuth(req);
  if (!user) return json({ error: 'Unauthorized. Please log in and try again.' }, 401);

  // 2. Parse form data
  let formData;
  try { formData = await req.formData(); }
  catch { return json({ error: 'Invalid request body.' }, 400); }

  const mode       = formData.get('mode') || 'statement'; // 'statement' | 'receipt'
  const currency   = formData.get('currency') || 'THB';
  const file       = formData.get('file');
  const catsRaw    = formData.get('categories');
  const categories = catsRaw ? JSON.parse(catsRaw) : [];

  if (!file) return json({ error: 'No file provided.' }, 400);

  // 3. Build Claude message content
  const content = [];
  const fileType = file.type || 'application/octet-stream';

  if (fileType === 'application/pdf') {
    // PDF: send as document block
    const bytes = await file.arrayBuffer();
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) },
    });
  } else if (fileType.startsWith('image/')) {
    // Receipt image
    const validType = ['image/jpeg','image/png','image/gif','image/webp'].includes(fileType)
      ? fileType : 'image/jpeg';
    const bytes = await file.arrayBuffer();
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: validType, data: toBase64(bytes) },
    });
  } else {
    // CSV or pre-converted text (Excel converted to CSV on the client)
    const text = await file.text();
    if (!text.trim()) return json({ error: 'The file appears to be empty.' }, 400);
    content.push({ type: 'text', text: `Bank statement data (${file.name}):\n\n${text}` });
  }

  // Add the prompt
  content.push({
    type: 'text',
    text: mode === 'receipt' ? receiptPrompt(currency) : statementPrompt(categories, currency),
  });

  // 4. Call Claude
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8096,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error('[process-statement] Claude API error:', errText);
    return json({ error: 'AI processing failed. Please try again in a moment.' }, 502);
  }

  const claudeData = await claudeRes.json();
  const rawText    = claudeData.content?.[0]?.text || '';

  // 5. Parse the JSON response
  try {
    const clean = rawText
      .replace(/^```json\s*/im, '')
      .replace(/^```\s*/im, '')
      .replace(/\s*```$/im, '')
      .trim();

    const data = JSON.parse(clean);
    return json({ ok: true, data, mode });

  } catch (e) {
    console.error('[process-statement] JSON parse error:', e.message);
    console.error('[process-statement] Raw response (first 400 chars):', rawText.substring(0, 400));
    return json({
      error: 'Could not parse the AI response. Try a different file format, or use the manual CSV import.',
      debug: rawText.substring(0, 200),
    }, 500);
  }
}
