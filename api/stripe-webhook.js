import crypto from 'node:crypto';
import { savePaidUnlock, stripePlanPriceId } from '../lib/plan-access.js';

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Webhook body is too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, header, secret) {
  const parts = String(header || '').split(',').map((part) => part.split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  return signatures.some((signature) => {
    const provided = Buffer.from(signature || '', 'hex');
    const target = Buffer.from(expected, 'hex');
    return provided.length === target.length && crypto.timingSafeEqual(provided, target);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const priceId = stripePlanPriceId();
  if (!webhookSecret || !serviceRoleKey || !priceId) return res.status(500).json({ error: 'Webhook is not configured' });

  try {
    const rawBody = await readRawBody(req);
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], webhookSecret)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    const event = JSON.parse(rawBody.toString('utf8'));
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return res.status(200).json({ received: true });
    }
    const session = event.data?.object || {};
    const userId = String(session.client_reference_id || '');
    const valid = session.mode === 'payment'
      && session.payment_status === 'paid'
      && session.metadata?.app === 'lucky'
      && session.metadata?.product === 'full_90_day_plan'
      && session.metadata?.user_id === userId
      && session.metadata?.price_id === priceId
      && /^[0-9a-f-]{36}$/i.test(userId)
      && /^cs_/.test(String(session.id || ''));
    if (!valid) return res.status(400).json({ error: 'Unexpected checkout session' });
    await savePaidUnlock(userId, session.id, serviceRoleKey);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('stripe-webhook failed:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
