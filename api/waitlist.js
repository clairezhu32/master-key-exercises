const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const rateLimit = new Map();

function isAllowedOrigin(origin) {
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin || '')) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin || '')) return true;
  return Boolean(process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });

  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Waitlist is not configured' });

  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const state = rateLimit.get(ip) || { start: now, count: 0 };
  if (now - state.start > 3_600_000) { state.start = now; state.count = 0; }
  state.count += 1;
  rateLimit.set(ip, state);
  if (state.count > 10) return res.status(429).json({ error: 'Too many submissions. Try again later.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = String(body.email || '').trim().toLowerCase();
    const source = String(body.source || '').slice(0, 100);

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_waitlist`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email, source }),
    });

    if (response.status === 409) return res.status(409).json({ error: 'This email is already on the list.' });
    if (!response.ok) throw new Error(`Waitlist write failed (${response.status})`);

    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('waitlist failed:', error);
    return res.status(500).json({ error: 'Could not join the waitlist. Please try again.' });
  }
}
