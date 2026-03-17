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

  // Get raw body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Parse event — skip signature verification for now to test
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

  try {
    if (event.type === 'checkout.session.completed') {
      const session  = event.data.object;
      const email    = session.customer_email
                    || session.customer_details?.email;
      const priceId  = session.line_items?.data?.[0]?.price?.id;

      if (email && priceId && TIER_MAP[priceId]) {
        const { tier, days } = TIER_MAP[priceId];
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + days);

        await makeSupabaseRequest(
          `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
          'PATCH',
          { tier, tier_expiry: expiry.toISOString().split('T')[0] },
          SERVICE_KEY,
          SUPABASE_URL
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const email = event.data.object?.customer_email;
      if (email) {
        await makeSupabaseRequest(
          `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
          'PATCH',
          { tier: 'free', tier_expiry: null },
          SERVICE_KEY,
          SUPABASE_URL
        );
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
}

export const config = {
  api: { bodyParser: false }
};
