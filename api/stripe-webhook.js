const https = require('https');

function makeSupabaseRequest(path, method, body, serviceKey, supabaseUrl) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(supabaseUrl);
    const options = {
      hostname: url.hostname,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Length': Buffer.byteLength(data),
        'Prefer': 'return=minimal'
      }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  const TIER_MAP = {
    'price_1TBrsdF7k2b7X0MjoEhddJIL': { tier: 'basic',   days: 365 },
    'price_1TBrttF7k2b7X0MjGJXrRR7V': { tier: 'premium', days: 365 },
    'price_1TBruyF7k2b7X0MjNIZ1dCel': { tier: 'premium', days: 36500 },
  };

  // Debug — log everything we can see
  const debugInfo = {
    eventType:     event.type,
    email:         null,
    priceId:       null,
    tierMapMatch:  null,
    supabaseUrl:   SUPABASE_URL ? 'set' : 'MISSING',
    serviceKey:    SERVICE_KEY  ? 'set' : 'MISSING',
  };

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      debugInfo.email   = session.customer_email || session.customer_details?.email || 'NOT FOUND';
      debugInfo.priceId = session.line_items?.data?.[0]?.price?.id || 'NOT IN SESSION - need expand';
      debugInfo.tierMapMatch = TIER_MAP[debugInfo.priceId] ? 'YES' : 'NO';

      // Try getting price from metadata or amount
      debugInfo.sessionKeys    = Object.keys(session);
      debugInfo.amountTotal    = session.amount_total;
      debugInfo.paymentStatus  = session.payment_status;
      debugInfo.subscriptionId = session.subscription;
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      debugInfo.email   = invoice.customer_email || 'NOT FOUND';
      debugInfo.priceId = invoice.lines?.data?.[0]?.price?.id || 'NOT FOUND';
      debugInfo.tierMapMatch = TIER_MAP[debugInfo.priceId] ? 'YES' : 'NO';
      debugInfo.subscriptionId = invoice.subscription;
    }

    // If we have email and priceId, try the update
    if (debugInfo.email && debugInfo.email !== 'NOT FOUND' &&
        debugInfo.priceId && TIER_MAP[debugInfo.priceId]) {

      const { tier, days } = TIER_MAP[debugInfo.priceId];
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + days);

      const result = await makeSupabaseRequest(
        `/rest/v1/profiles?email=eq.${encodeURIComponent(debugInfo.email)}`,
        'PATCH',
        { tier, tier_expiry: expiry.toISOString().split('T')[0] },
        SERVICE_KEY,
        SUPABASE_URL
      );

      debugInfo.supabaseResult = result;
      debugInfo.tierApplied    = tier;
    }

  } catch (err) {
    debugInfo.error = err.message;
  }

  // Return debug info in response so we can see it in Stripe
  return res.status(200).json({ received: true, debug: debugInfo });
}

export const config = {
  api: { bodyParser: false }
};
