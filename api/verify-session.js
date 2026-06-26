export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
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

  // Expand line_items so we can assert the price matches this product.
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`;
  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`Stripe verify ${upstream.status}: ${detail}`);
    return res.status(502).json({ error: 'Verification failed' });
  }

  const session = await upstream.json();

  // Guard 1: must be stamped by our create-checkout handler.
  if (session.metadata?.app !== 'mks') {
    return res.status(403).json({ unlocked: false, error: 'Session not issued by this app' });
  }

  // Guard 2: price must match the configured product — prevents using a paid
  // session from a different product on the same Stripe account.
  const linePrice = session.line_items?.data?.[0]?.price?.id;
  if (linePrice !== priceId) {
    console.error(`Price mismatch: expected ${priceId}, got ${linePrice}`);
    return res.status(403).json({ unlocked: false, error: 'Price mismatch' });
  }

  // Guard 3: payment must have completed.
  if (session.payment_status === 'paid') {
    return res.status(200).json({ unlocked: true });
  }
  return res.status(402).json({ unlocked: false });
}
