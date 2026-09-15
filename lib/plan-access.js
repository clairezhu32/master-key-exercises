export const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';

export function requestOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  try { return new URL(req.headers.referer || '').origin; } catch { return ''; }
}

export function isAllowedOrigin(origin) {
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin || '')) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin || '')) return true;
  return Boolean(process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN);
}

export async function getUserFromToken(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey },
  });
  return response.ok ? response.json() : null;
}

function serviceHeaders(serviceRoleKey, extra = {}) {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, ...extra };
}

export async function getPlanAccess(userId, serviceRoleKey) {
  const generationResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${encodeURIComponent(userId)}&select=goal_data&limit=1`, {
    headers: serviceHeaders(serviceRoleKey),
  });
  if (!generationResponse.ok) throw new Error(`Could not verify plan access (${generationResponse.status})`);
  const record = (await generationResponse.json())[0] || null;
  const beta = Boolean(record?.goal_data?._beta_access);

  const unlockResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_unlocks?user_id=eq.${encodeURIComponent(userId)}&select=unlocked_at&limit=1`, {
    headers: serviceHeaders(serviceRoleKey),
  });
  // A valid beta invitation already unlocks the plan. Do not withhold a
  // successfully generated/saved plan just because the optional paid-unlock
  // lookup is temporarily unavailable or its migration has not been applied.
  if (!unlockResponse.ok) {
    if (beta) {
      console.warn(`Paid unlock lookup failed (${unlockResponse.status}); using verified beta access for ${userId}`);
      return { unlocked: true, source: 'beta' };
    }
    throw new Error(`Could not verify plan access (${unlockResponse.status})`);
  }
  const paid = Boolean((await unlockResponse.json())[0]);
  return { unlocked: paid || beta, source: paid ? 'paid' : beta ? 'beta' : 'free' };
}

export function createPlanPreview(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const firstWeek = Array.isArray(plan.weeks) ? plan.weeks.slice(0, 1) : [];
  const weekExercisePart = Number(firstWeek[0]?.exercise_part);
  const exercises = Array.isArray(plan.exercises)
    ? plan.exercises.filter((exercise) => Number(exercise.part) === weekExercisePart).slice(0, 1)
    : [];
  const { funnel: _hiddenFunnel, weeks: _hiddenWeeks, exercises: _hiddenExercises, ...summary } = plan;
  return { ...summary, weeks: firstWeek, exercises };
}

export function stripePlanPriceId() {
  return process.env.STRIPE_PLAN_PRICE_ID || process.env.STRIPE_PRICE_ID || '';
}

export async function savePaidUnlock(userId, sessionId, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_unlocks?on_conflict=user_id`, {
    method: 'POST',
    headers: serviceHeaders(serviceRoleKey, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify({ user_id: userId, stripe_session_id: sessionId, unlocked_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Unlock save failed (${response.status})`);
}
