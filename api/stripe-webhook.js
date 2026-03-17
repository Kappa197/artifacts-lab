const https = require('https');

function stripeRequest(path, secretKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function supabaseRequest(path, method, body, serviceKey, supabaseUrl) {
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

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

  const TIER_MAP = {
    'price_1TBrsdF7k2b7X0MjoEhddJIL': { tier: 'basic',   days: 365 },
    'price_1TBrttF7k2b7X0MjGJXrRR7V': { tier: 'premium', days: 365 },
    'price_1TBruyF7k2b7X0MjNIZ1dCel': { tier: 'premium', days: 36500 },
  };

  try {
    let email   = null;
    let priceId = null;

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      email = session.customer_email || session.customer_details?.email;

      // Fetch line items from Stripe API to get price ID
      if (session.id) {
        const lineItems = await stripeRequest(
          `/v1/checkout/sessions/${session.id}/line_items`,
          STRIPE_SECRET
        );
        priceId = lineItems?.data?.[0]?.price?.id;
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      email   = invoice.customer_email;
      priceId = invoice.lines?.data?.[0]?.price?.id;

      // If still not found, fetch invoice from Stripe
      if (!priceId && invoice.id) {
        const fullInvoice = await stripeRequest(
          `/v1/invoices/${invoice.id}`,
          STRIPE_SECRET
        );
        priceId = fullInvoice?.lines?.data?.[0]?.price?.id;
      }
    }

    // Update Supabase if we have everything
    if (email && priceId && TIER_MAP[priceId]) {
      const { tier, days } = TIER_MAP[priceId];
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + days);

      await supabaseRequest(
        `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
        'PATCH',
        { tier, tier_expiry: expiry.toISOString().split('T')[0] },
        SERVICE_KEY,
        SUPABASE_URL
      );

      return res.status(200).json({
        received: true,
        updated: { email, tier, expiry: expiry.toISOString().split('T')[0] }
      });
    }

    return res.status(200).json({
      received: true,
      skipped: { email, priceId, reason: 'no tier match' }
    });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
}

export const config = {
  api: { bodyParser: false }
};
