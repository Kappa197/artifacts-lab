import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // Handle payment events
  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.payment_succeeded') {

    const session = event.data.object;
    const email   = session.customer_email || session.customer_details?.email;
    const priceId = session.line_items?.data[0]?.price?.id
                 || session.lines?.data[0]?.price?.id;

    if (!email) {
      return res.status(200).json({ received: true });
    }

    // Map price ID to tier
    const TIER_MAP = {
      'price_1TBrsdF7k2b7X0MjoEhddJIL': { tier: 'basic',   days: 365 },
      'price_1TBrttF7k2b7X0MjGJXrRR7V': { tier: 'premium', days: 365 },
      'price_1TBruyF7k2b7X0MjNIZ1dCel': { tier: 'premium', days: 36500 },
    };

    const mapping = TIER_MAP[priceId];
    if (!mapping) return res.status(200).json({ received: true });

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + mapping.days);

    // Update user tier in Supabase
    await db
      .from('profiles')
      .update({
        tier: mapping.tier,
        tier_expiry: expiry.toISOString().split('T')[0]
      })
      .eq('email', email);
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    const sub   = event.data.object;
    const email = sub.customer_email;
    if (email) {
      await db
        .from('profiles')
        .update({ tier: 'free', tier_expiry: null })
        .eq('email', email);
    }
  }

  return res.status(200).json({ received: true });
}

export const config = {
  api: { bodyParser: false }
};
