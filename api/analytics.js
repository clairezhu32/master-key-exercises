const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin)) return true;
  const custom = process.env.ALLOWED_ORIGIN;
  if (custom && origin === custom) return true;
  return false;
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

// mks_events has no client-side read policy at all (see supabase-schema.sql)
// — access is gated here instead of via RLS, so this list is the single
// source of truth for who can see registration data, not a duplicated
// policy that could drift out of sync with it.
function isAdmin(email) {
  const allowed = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes((email || '').toLowerCase());
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Analytics not configured' });
  }

  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (!isAdmin(user.email)) return res.status(403).json({ error: 'Not authorized' });

  try {
    const [allRes, recentRes, betaRes, funnelRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/mks_events?event_name=eq.user_registered&select=created_at&order=created_at.asc`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: 'count=exact',
          },
        }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/mks_events?event_name=eq.user_registered&select=email,properties,created_at&order=created_at.desc&limit=20`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/mks_goal_generations?select=email,goal_data&order=generated_at.desc&limit=250`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/mks_events?event_name=in.(quiz_started,quiz_completed,plan_generated,plan_saved,plan_shared,task_completed,returning_user)&select=event_name,created_at&order=created_at.desc&limit=5000`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
      ),
    ]);

    if (!allRes.ok || !recentRes.ok || !betaRes.ok || !funnelRes.ok) {
      throw new Error(`analytics query failed: ${allRes.status}/${recentRes.status}/${betaRes.status}/${funnelRes.status}`);
    }

    const totalRegistrations = Number(allRes.headers.get('content-range')?.split('/')[1] || 0);
    const allTimestamps = await allRes.json();
    const recent = await recentRes.json();
    const betaRows = await betaRes.json();
    const funnelRows = await funnelRes.json();
    const betaMembers = betaRows.filter((row) => row.goal_data?._beta_access);
    const feedback = betaRows.flatMap((row) => Object.entries(row.goal_data?._beta_feedback || {}).map(([stage, entry]) => ({
      email: row.email,
      stage,
      answers: entry.answers || {},
      submitted_at: entry.submitted_at,
      campaign: row.goal_data?._beta_access?.campaign || 'existing-user',
    }))).sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    const funnelNames = ['quiz_started', 'quiz_completed', 'plan_generated', 'plan_saved', 'plan_shared', 'task_completed', 'returning_user'];
    const cutoff = Date.now() - 30 * 86_400_000;
    const funnel = Object.fromEntries(funnelNames.map((name) => [name, {
      total: funnelRows.filter((row) => row.event_name === name).length,
      last30: funnelRows.filter((row) => row.event_name === name && new Date(row.created_at).getTime() >= cutoff).length,
    }]));

    // Bucket into the last 30 UTC days, including days with zero.
    const dayBuckets = new Map();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dayBuckets.set(d.toISOString().split('T')[0], 0);
    }
    for (const row of allTimestamps) {
      const day = row.created_at.split('T')[0];
      if (dayBuckets.has(day)) dayBuckets.set(day, dayBuckets.get(day) + 1);
    }
    const daily = [...dayBuckets.entries()].map(([date, count]) => ({ date, count }));

    return res.status(200).json({ totalRegistrations, daily, recent, funnel, beta: { members: betaMembers.length, feedbackSubmissions: feedback.length, feedback } });
  } catch (err) {
    console.error('analytics query failed:', err);
    return res.status(500).json({ error: 'Failed to load analytics' });
  }
}
