const https  = require('https');
const crypto = require('crypto');

function stripeRequest(path, secretKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path: path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${secretKey}` }
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
    const url  = new URL(supabaseUrl);
    const options = {
      hostname: url.hostname,
      path: path,
      method: method,
      headers: {
        'Content-Type':   'application/json',
        'apikey':         serviceKey,
        'Authorization':  `Bearer ${serviceKey}`,
        'Content-Length': Buffer.byteLength(data),
        'Prefer':         'return=minimal'
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

  // Read raw body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  // Environment variables
  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify Stripe signature
  const sig       = req.headers['stripe-signature'] || '';
  const timestamp = sig.match(/t=(\d+)/)?.[1];
  const v1sig     = sig.match(/v1=([a-f0-9]+)/)?.[1];

  if (!timestamp || !v1sig || !WEBHOOK_SECRET) {
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  if (expected !== v1sig) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Reject requests older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) {
    return res.status(400).json({ error: 'Request too old' });
  }

  // Parse event
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Tier map
  const TIER_MAP = {
    'price_1TBrsdF7k2b7X0MjoEhddJIL': { tier: 'basic',   days: 365   },
    'price_1TBrttF7k2b7X0MjGJXrRR7V': { tier: 'premium', days: 365   },
    'price_1TBruyF7k2b7X0MjNIZ1dCel': { tier: 'premium', days: 36500 },
  };

  try {
    let email   = null;
    let priceId = null;

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      email = session.customer_email || session.customer_details?.email;
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
      if (!priceId && invoice.id) {
        const fullInvoice = await stripeRequest(
          `/v1/invoices/${invoice.id}`,
          STRIPE_SECRET
        );
        priceId = fullInvoice?.lines?.data?.[0]?.price?.id;
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      email = sub.customer_email;
      if (email) {
        await supabaseRequest(
          `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
          'PATCH',
          { tier: 'free', tier_expiry: null },
          SERVICE_KEY,
          SUPABASE_URL
        );
        return res.status(200).json({ received: true, downgraded: email });
      }
    }

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
    console.error('Webhook error:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}

export const config = {
  api: { bodyParser: false }
};
