// api/process-statement.js
// Vercel Edge Function — AI Statement Import + Receipt Scanning
// Uses streaming to stay within Vercel Hobby free plan limits

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://fvgajfiksxmwioxnesry.supabase.co';

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

function statementPrompt(currency) {
  return `Convert this bank statement into a JSON array. Each object must have exactly these keys:
{"date":"copy exactly as shown","description":"copy exactly, do not translate","debit":<number or null>,"credit":<number or null>}

RULES:
1. Include EVERY transaction. Do not skip any row.
2. debit: amount when money LEFT the account (purchase, fee, transfer out). null if incoming.
3. credit: amount when money ARRIVED (salary, refund, transfer in). null if outgoing.
4. Amounts: plain numbers, period as decimal. Example: 1250.50. No currency symbols.
5. Currency is ${currency}. Do not convert amounts.
6. OUTPUT ONLY the raw JSON array. No explanation, no markdown. First character must be [

Your entire response must be the JSON array only, starting with [ and ending with ]`;
}

function receiptPrompt(currency) {
  return `Extract key details from this receipt image.

OUTPUT FORMAT — a single JSON object:
{"date":"YYYY-MM-DD if readable, otherwise null","merchant":"store name","amount":<total as number>,"description":"merchant and brief context"}

RULES:
1. amount: the TOTAL charged. Plain number, period as decimal.
2. Currency is ${currency}. Do not convert.
3. OUTPUT ONLY the raw JSON object. No markdown. Start with {`;
}

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

function extractJSON(text, mode) {
  if (!text) throw new Error('Empty response from AI');
  text = text.replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```$/im, '').trim();
  try { return JSON.parse(text); } catch {}
  if (mode !== 'receipt') {
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  }
  const os = text.indexOf('{'), oe = text.lastIndexOf('}');
  if (os !== -1 && oe > os) { try { return JSON.parse(text.slice(os, oe + 1)); } catch {} }
  try {
    return JSON.parse(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/,\s*([}\]])/g, '$1'));
  } catch {}
  throw new Error('Response was not valid JSON');
}

export default async function handler(req) {
  // Outer safety net — always returns JSON even on unexpected crash
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

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return jsonResponse({ error: 'Server configuration error: missing API key.' }, 500);

  const authed = await verifyAuth(req);
  if (!authed) return jsonResponse({ error: 'Unauthorized. Please log in and try again.' }, 401);

  let formData;
  try { formData = await req.formData(); }
  catch (e) { return jsonResponse({ error: 'Could not parse request: ' + e.message }, 400); }

  const mode     = formData.get('mode') || 'statement';
  const currency = formData.get('currency') || 'THB';
  const file     = formData.get('file');
  if (!file) return jsonResponse({ error: 'No file provided.' }, 400);

  // Build Claude message content
  const content  = [];
  const fileType = file.type || 'application/octet-stream';

  if (fileType === 'application/pdf') {
    const bytes = await file.arrayBuffer();
    content.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data:toBase64(bytes) } });
  } else if (fileType.startsWith('image/')) {
    const validType = ['image/jpeg','image/png','image/gif','image/webp'].includes(fileType) ? fileType : 'image/jpeg';
    const bytes = await file.arrayBuffer();
    content.push({ type:'image', source:{ type:'base64', media_type:validType, data:toBase64(bytes) } });
  } else {
    const text = await file.text();
    if (!text.trim()) return jsonResponse({ error: 'The file appears to be empty.' }, 400);
    content.push({ type:'text', text:`Bank statement (${file.name}):\n\n${text}` });
  }
  content.push({ type:'text', text: mode === 'receipt' ? receiptPrompt(currency) : statementPrompt(currency) });

  // Call Claude API with streaming enabled
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 8096,
      stream:     true,   // ← streaming keeps Vercel connection alive
      messages:   [{ role:'user', content }],
    }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error('[process-statement] Claude error', claudeRes.status, errText.slice(0, 200));
    return jsonResponse({
      error: `AI service error (${claudeRes.status}). ${claudeRes.status === 401 ? 'Check your API key.' : 'Please try again.'}`,
    }, 502);
  }

  // Stream Claude's SSE response through, collecting the full text
  // Then return a single JSON response once complete
  const stream = new ReadableStream({
    async start(controller) {
      const reader  = claudeRes.body.getReader();
      const decoder = new TextDecoder();
      let fullText  = '';
      let buffer    = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete last line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                fullText += evt.delta.text;
              }
            } catch {}
          }
        }

        // Parse the complete response and return as JSON
        const data   = extractJSON(fullText, mode);
        const result = JSON.stringify({ ok:true, data, mode });
        controller.enqueue(new TextEncoder().encode(result));
        controller.close();

      } catch (e) {
        console.error('[process-statement] Stream processing error:', e.message);
        console.error('[process-statement] Raw (first 300):', fullText.slice(0, 300));
        const errResult = JSON.stringify({ error: 'Could not parse AI response: ' + e.message });
        controller.enqueue(new TextEncoder().encode(errResult));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
