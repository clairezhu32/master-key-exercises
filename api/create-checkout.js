// Vercel preview deployments use the pattern:
//   master-key-exercises-<hash>-<team>.vercel.app
// The regex only allows that exact prefix before the first dot.
const ALLOWED_ORIGIN_RE = /^https:\/\/master-key-exercises(-[a-z0-9]+-[a-z0-9-]+)?\.vercel\.app$/;

const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (ALLOWED_ORIGIN_RE.test(origin)) return true;
  const custom = process.env.ALLOWED_ORIGIN;
  return !!(custom && origin === custom);
}

async function getUserFromToken(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || !priceId || !serviceRoleKey) {
    console.error('STRIPE_SECRET_KEY, STRIPE_PRICE_ID, or SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Payment not configured' });
  }

  // Derive origin from the request header — never trust the body for redirect URLs.
  const origin = req.headers.origin ?? '';
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) {
    return res.status(401).json({ error: 'Sign in required' });
  }

  const params = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    allow_promotion_codes: 'true',
    customer_email: user.email,
    client_reference_id: user.id,
    success_url: `${origin}/goals?checkout=success`,
    cancel_url: `${origin}/goals?checkout=cancelled`,
    // Stamp every session so the webhook can link it back to the Supabase user
    // without trusting anything from the client.
    'metadata[app]': 'mks',
    'metadata[user_id]': user.id,
  });

  const upstream = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`Stripe ${upstream.status}: ${detail}`);
    return res.status(502).json({ error: 'Payment service unavailable' });
  }

  const session = await upstream.json();
  return res.status(200).json({ url: session.url });
}
