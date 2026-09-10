import { getPlanAccess, getUserFromToken, isAllowedOrigin, requestOrigin, savePaidUnlock, stripePlanPriceId } from '../lib/plan-access.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAllowedOrigin(requestOrigin(req))) return res.status(403).json({ error: 'Forbidden' });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = stripePlanPriceId();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || !priceId || !serviceRoleKey) return res.status(500).json({ error: 'Payment is not configured yet' });
  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Invalid request body' }); }
  const sessionId = String(body.sessionId || '');
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
    return res.status(400).json({ error: 'Invalid checkout session' });
  }

  try {
    const existing = await getPlanAccess(user.id, serviceRoleKey);
    if (existing.unlocked) return res.status(200).json(existing);
    const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!stripeResponse.ok) throw new Error(`Stripe verification failed (${stripeResponse.status})`);
    const session = await stripeResponse.json();
    const linePrice = session.line_items?.data?.[0]?.price?.id;
    const belongsToUser = session.client_reference_id === user.id && session.metadata?.user_id === user.id;
    const isLuckyPlan = session.metadata?.app === 'lucky' && session.metadata?.product === 'full_90_day_plan';
    if (!belongsToUser || !isLuckyPlan || linePrice !== priceId || session.payment_status !== 'paid' || session.mode !== 'payment') {
      return res.status(403).json({ unlocked: false, error: 'This payment cannot unlock this account' });
    }

    await savePaidUnlock(user.id, session.id, serviceRoleKey);
    return res.status(200).json({ unlocked: true, source: 'paid' });
  } catch (error) {
    console.error('verify-session failed:', error);
    return res.status(502).json({ unlocked: false, error: 'We could not confirm the payment yet' });
  }
}
