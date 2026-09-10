import { getPlanAccess, getUserFromToken, isAllowedOrigin, requestOrigin, stripePlanPriceId } from '../lib/plan-access.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = stripePlanPriceId();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || !priceId || !serviceRoleKey) {
    console.error('STRIPE_SECRET_KEY, STRIPE_PLAN_PRICE_ID (or STRIPE_PRICE_ID), or SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Payment is not configured yet' });
  }

  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const access = await getPlanAccess(user.id, serviceRoleKey);
    if (access.unlocked) return res.status(200).json({ unlocked: true });

    const priceResponse = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!priceResponse.ok) throw new Error(`Stripe price lookup failed (${priceResponse.status})`);
    const price = await priceResponse.json();
    if (!price.active || price.type !== 'one_time') {
      console.error(`Lucky plan price must be an active one-time Stripe price; received ${price.type}`);
      return res.status(500).json({ error: 'The Lucky upgrade price needs attention' });
    }

    const params = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      allow_promotion_codes: 'true',
      customer_email: user.email,
      client_reference_id: user.id,
      success_url: `${origin}/goals?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/goals?checkout=cancelled`,
      'metadata[app]': 'lucky',
      'metadata[product]': 'full_90_day_plan',
      'metadata[user_id]': user.id,
      'metadata[price_id]': priceId,
    });
    const checkoutResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!checkoutResponse.ok) {
      const detail = await checkoutResponse.text().catch(() => '');
      console.error(`Stripe checkout ${checkoutResponse.status}: ${detail}`);
      throw new Error('Stripe checkout failed');
    }
    const checkout = await checkoutResponse.json();
    return res.status(200).json({ url: checkout.url });
  } catch (error) {
    console.error('create-checkout failed:', error);
    return res.status(502).json({ error: 'Payment service is unavailable right now' });
  }
}
