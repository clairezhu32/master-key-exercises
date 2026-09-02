const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const PLAN_LIMIT = 3;

function isAllowedOrigin(origin) {
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin || '')) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin || '')) return true;
  return Boolean(process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN);
}

function requestOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  try { return new URL(req.headers.referer || '').origin; } catch { return ''; }
}

async function getUser(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey } });
  return response.ok ? response.json() : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAllowedOrigin(requestOrigin(req))) return res.status(403).json({ error: 'Forbidden' });
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Plan recovery is not configured' });
  const user = await getUser(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${user.id}&select=goal_data,plan,generated_at&limit=1`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!response.ok) throw new Error(`Plan query failed (${response.status})`);
    const record = (await response.json())[0] || null;
    const count = Number(record?.goal_data?._generation_count);
    const used = Number.isFinite(count) ? count : record?.plan ? 1 : 0;
    const answers = Object.fromEntries(Object.entries(record?.goal_data || {}).filter(([key]) => !key.startsWith('_')));
    return res.status(200).json({
      usage: { used, remaining: Math.max(0, PLAN_LIMIT - used), limit: PLAN_LIMIT },
      savedPlan: record?.plan ? { answers, plan: record.plan, savedAt: record.generated_at } : null,
    });
  } catch (error) {
    console.error('saved-plan failed:', error);
    return res.status(500).json({ error: 'Could not recover the saved plan' });
  }
}
