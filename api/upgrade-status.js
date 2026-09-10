import { getPlanAccess, getUserFromToken, isAllowedOrigin, requestOrigin, stripePlanPriceId } from '../lib/plan-access.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAllowedOrigin(requestOrigin(req))) return res.status(403).json({ error: 'Forbidden' });
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Plan access is not configured' });
  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const access = await getPlanAccess(user.id, serviceRoleKey);
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const priceId = stripePlanPriceId();
    let price = null;
    if (!access.unlocked && secretKey && priceId) {
      const priceResponse = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      if (priceResponse.ok) {
        const stripePrice = await priceResponse.json();
        if (stripePrice.active && stripePrice.type === 'one_time') {
          price = { amount: stripePrice.unit_amount, currency: stripePrice.currency };
        }
      }
    }
    return res.status(200).json({ ...access, configured: access.unlocked || Boolean(price), price });
  } catch (error) {
    console.error('upgrade-status failed:', error);
    return res.status(500).json({ error: 'Could not check plan access' });
  }
}
