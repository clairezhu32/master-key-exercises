import crypto from 'node:crypto';

const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const BUILT_IN_CODES = new Map([
  ['2f393d2e18a37dbbe6dca3414b057b117f8a25bdc54753d1d81ee305dbdfc2d0', { campaign: 'bootcamp-job-search', maxUses: 100, expiresAt: '2026-12-31T23:59:59Z' }],
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin)) return true;
  return Boolean(process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN);
}

async function getUser(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey },
  });
  return response.ok ? response.json() : null;
}

async function getRecord(userId, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}&select=goal_data,plan,generated_at&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error('Could not read beta access');
  return (await response.json())[0] || null;
}

async function saveGoalData(user, goalData, recordExists, serviceRoleKey) {
  const url = recordExists
    ? `${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${user.id}`
    : `${SUPABASE_URL}/rest/v1/mks_goal_generations`;
  const response = await fetch(url, {
    method: recordExists ? 'PATCH' : 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(recordExists ? { goal_data: goalData } : { user_id: user.id, email: user.email, goal_data: goalData }),
  });
  if (!response.ok) throw new Error('Could not save beta access');
}

async function track(eventName, user, properties, serviceRoleKey) {
  await fetch(`${SUPABASE_URL}/rest/v1/mks_events`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ event_name: eventName, user_id: user.id, email: user.email, properties }),
  }).catch(() => {});
}

function codeConfig(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized || normalized.length > 80) return null;
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  if (BUILT_IN_CODES.has(hash)) return BUILT_IN_CODES.get(hash);
  const extraHashes = String(process.env.BETA_INVITE_CODE_HASHES || '').split(',').map(item => item.trim()).filter(Boolean);
  return extraHashes.includes(hash) ? { campaign: 'private-invite', maxUses: 100, expiresAt: null } : null;
}

async function campaignUseCount(campaign, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?select=id&goal_data->_beta_access->>campaign=eq.${encodeURIComponent(campaign)}&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Prefer: 'count=exact' },
  });
  if (!response.ok) throw new Error('Could not verify invitation availability');
  return Number(response.headers.get('content-range')?.split('/')[1] || 0);
}

function cleanAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, answer]) => [String(key).slice(0, 60), String(answer ?? '').trim().slice(0, 2000)]));
}

export default async function handler(req, res) {
  if (!isAllowedOrigin(req.headers.origin || '')) return res.status(403).json({ error: 'Forbidden' });
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Beta access is not configured' });
  const user = await getUser(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const record = await getRecord(user.id, serviceRoleKey);
    const goalData = record?.goal_data || {};
    const access = goalData._beta_access || null;
    const feedback = goalData._beta_feedback || {};

    if (req.method === 'GET') {
      return res.status(200).json({ allowed: Boolean(access), access, feedback: Object.keys(feedback) });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.action === 'redeem') {
      if (access) return res.status(200).json({ allowed: true, access });
      const config = codeConfig(body.code);
      if (!config) return res.status(403).json({ error: 'That invitation code is not valid. Please check it and try again.' });
      if (config.expiresAt && Date.now() > new Date(config.expiresAt).getTime()) return res.status(403).json({ error: 'That invitation code has expired.' });
      if (await campaignUseCount(config.campaign, serviceRoleKey) >= config.maxUses) return res.status(403).json({ error: 'That invitation group is full. Please contact Claire for another code.' });
      const nextAccess = { campaign: config.campaign, redeemed_at: new Date().toISOString() };
      await saveGoalData(user, { ...goalData, _beta_access: nextAccess }, Boolean(record), serviceRoleKey);
      await track('beta_invite_redeemed', user, { campaign: config.campaign }, serviceRoleKey);
      return res.status(200).json({ allowed: true, access: nextAccess });
    }

    if (body.action === 'feedback') {
      if (!access) return res.status(403).json({ error: 'Invitation required' });
      if (!['first_action', 'seven_day'].includes(body.stage)) return res.status(400).json({ error: 'Invalid feedback stage' });
      const entry = { answers: cleanAnswers(body.answers), submitted_at: new Date().toISOString() };
      const nextFeedback = { ...feedback, [body.stage]: entry };
      await saveGoalData(user, { ...goalData, _beta_feedback: nextFeedback }, Boolean(record), serviceRoleKey);
      await track('beta_feedback_submitted', user, { stage: body.stage, campaign: access.campaign }, serviceRoleKey);
      return res.status(200).json({ saved: true, feedback: Object.keys(nextFeedback) });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('beta-access failed:', error);
    return res.status(500).json({ error: error.message || 'Beta access failed' });
  }
}
