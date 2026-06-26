export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Payment not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { sessionId } = body ?? {};
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const upstream = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`Stripe verify ${upstream.status}: ${detail}`);
    return res.status(502).json({ error: 'Verification failed' });
  }

  const session = await upstream.json();
  if (session.payment_status === 'paid') {
    return res.status(200).json({ unlocked: true });
  }
  return res.status(402).json({ unlocked: false });
}
