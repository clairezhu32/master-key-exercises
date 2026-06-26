// Vercel preview deployments use the pattern:
//   master-key-exercises-<hash>-<team>.vercel.app
// The regex only allows that exact prefix before the first dot.
const ALLOWED_ORIGIN_RE = /^https:\/\/master-key-exercises(-[a-z0-9]+-[a-z0-9-]+)?\.vercel\.app$/;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (ALLOWED_ORIGIN_RE.test(origin)) return true;
  const custom = process.env.ALLOWED_ORIGIN;
  return !!(custom && origin === custom);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    console.error('STRIPE_SECRET_KEY or STRIPE_PRICE_ID not set');
    return res.status(500).json({ error: 'Payment not configured' });
  }

  // Derive origin from the request header — never trust the body for redirect URLs.
  const origin = req.headers.origin ?? '';
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    success_url: `${origin}/exercises?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/exercises?cancelled=1`,
    // Stamp every session so verify-session can assert it belongs to this app + price.
    'metadata[app]': 'mks',
    'metadata[price_id]': priceId,
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
