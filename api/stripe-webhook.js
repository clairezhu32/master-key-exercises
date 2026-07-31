import crypto from 'crypto';

// Disable Vercel's automatic body parsing — Stripe signature verification needs
// the exact raw bytes of the request body, not a re-serialized JSON object.
export const config = {
  api: { bodyParser: false },
};

const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const SIGNATURE_TOLERANCE_SECONDS = 300;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx), p.slice(idx + 1)];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false;
  }
}

async function supabaseRequest(serviceRoleKey, path, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${detail}`);
  }
}

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !stripeSecretKey || !serviceRoleKey) {
    console.error('STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, or SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const rawBody = await readRawBody(req);
  const rawBodyStr = rawBody.toString('utf8');

  if (!verifyStripeSignature(rawBodyStr, req.headers['stripe-signature'], webhookSecret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBodyStr);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id || session.client_reference_id;
      if (userId && session.subscription) {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${session.subscription}`, {
          headers: { Authorization: `Bearer ${stripeSecretKey}` },
        });
        if (!subRes.ok) throw new Error(`Stripe subscription fetch failed: ${subRes.status}`);
        const sub = await subRes.json();

        await supabaseRequest(serviceRoleKey, 'mks_subscriptions?on_conflict=user_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            user_id: userId,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            status: sub.status,
            current_period_end: toIso(sub.current_period_end),
            updated_at: new Date().toISOString(),
          }),
        });
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabaseRequest(serviceRoleKey, `mks_subscriptions?stripe_subscription_id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: sub.status,
          current_period_end: toIso(sub.current_period_end),
          updated_at: new Date().toISOString(),
        }),
      });
    }
    // Other event types are intentionally ignored.
  } catch (err) {
    // Return 500 so Stripe retries with backoff — swallowing this would mean a
    // subscription silently never syncs on a transient Supabase/network error.
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  return res.status(200).json({ received: true });
}
