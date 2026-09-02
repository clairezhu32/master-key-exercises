const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const rateLimit = new Map();
const ALLOWED_EVENTS = new Set([
  'quiz_started', 'quiz_step_completed', 'quiz_completed', 'plan_generated',
  'plan_saved', 'plan_shared', 'task_completed', 'returning_user',
]);

function isAllowedOrigin(origin) {
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin || '')) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin || '')) return true;
  return Boolean(process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN);
}

async function getUser(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey } });
  return response.ok ? response.json() : null;
}

function cleanProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [String(key).slice(0, 60), typeof item === 'number' || typeof item === 'boolean' ? item : String(item ?? '').slice(0, 300)]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAllowedOrigin(req.headers.origin || '')) return res.status(403).json({ error: 'Forbidden' });
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Events are not configured' });

  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now(), state = rateLimit.get(ip) || { start: now, count: 0 };
  if (now - state.start > 3_600_000) { state.start = now; state.count = 0; }
  state.count += 1; rateLimit.set(ip, state);
  if (state.count > 120) return res.status(429).json({ error: 'Too many events' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!ALLOWED_EVENTS.has(body.event_name)) return res.status(400).json({ error: 'Unknown event' });
    const user = await getUser(req.headers.authorization, serviceRoleKey);
    const properties = { ...cleanProperties(body.properties), visitor_id: String(body.visitor_id || '').slice(0, 100) };
    const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_events`, {
      method: 'POST',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ event_name: body.event_name, user_id: user?.id || null, email: user?.email || null, properties }),
    });
    if (!response.ok) throw new Error(`Event write failed (${response.status})`);
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('events failed:', error);
    return res.status(500).json({ error: 'Could not record event' });
  }
}
