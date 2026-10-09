import crypto from 'node:crypto';
import { getPlanAccess } from '../lib/plan-access.js';

const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';
const messageRateLimit = new Map();
const FUNNEL_METRIC_KEYS = [
  'applications', 'responses', 'interviews', 'offers',
  'people_met', 'mutual_interest', 'first_dates', 'repeat_dates', 'active_prospects',
  'follow_ups', 'one_to_one_plans', 'repeat_contact', 'reciprocal_connections',
];

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

async function getRecordByUser(userId, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}&select=user_id,email,goal_data,plan,generated_at&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`Plan query failed (${response.status})`);
  return (await response.json())[0] || null;
}

async function getRecordByShareToken(token, serviceRoleKey) {
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?goal_data->_accountability->>token_hash=eq.${hash}&select=user_id,email,goal_data,plan,generated_at&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`Buddy link query failed (${response.status})`);
  return (await response.json())[0] || null;
}

async function saveGoalData(userId, goalData, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ goal_data: goalData }),
  });
  if (!response.ok) throw new Error(`Plan update failed (${response.status})`);
}

function taskEstimateKey(weekNumber, actionIndex) {
  return `week-${weekNumber}-task-${actionIndex}`;
}

function inferTaskMinutes(action) {
  const text = String(action || '').toLowerCase();
  const explicitMinutes = text.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/);
  if (explicitMinutes) return Math.max(5, Math.min(480, Number(explicitMinutes[1])));
  const explicitHours = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (explicitHours) return Math.max(15, Math.min(480, Math.round(Number(explicitHours[1]) * 60)));
  if (/\b(mock interview|case practice|presentation|portfolio|workshop)\b/.test(text)) return 60;
  if (/\b(resume|cover letter|research|analy[sz]e|draft|write|build|create)\b/.test(text)) return 45;
  if (/\b(apply|submit|reach out|follow up|message|network|review|practice)\b/.test(text)) return 30;
  if (/\b(schedule|book|confirm|email|choose|list)\b/.test(text)) return 15;
  return 30;
}

function buildTaskEstimates(plan, stored = {}) {
  const estimates = {};
  for (const [weekIndex, week] of (plan?.weeks || []).entries()) {
    const weekNumber = Number(week.week || weekIndex + 1);
    for (const [actionIndex, action] of (week.actions || []).entries()) {
      const key = taskEstimateKey(weekNumber, actionIndex);
      const saved = Number(stored?.[key]);
      estimates[key] = Number.isFinite(saved) && saved >= 5 && saved <= 480 ? saved : inferTaskMinutes(action);
    }
  }
  return estimates;
}

function deriveCareerFunnel(weeks, completed, stored = {}) {
  const derived = { applications: 0, responses: 0, interviews: 0, offers: 0 };
  for (const [weekIndex, week] of (weeks || []).entries()) {
    const weekNumber = Number(week.week || weekIndex + 1);
    for (const [actionIndex, action] of (week.actions || []).entries()) {
      if (!completed?.[taskEstimateKey(weekNumber, actionIndex)]) continue;
      const text = String(action || '').toLowerCase();
      if (/\boffer(?:s|ed)?\b/.test(text)) derived.offers += 1;
      else if (/\b(interview|recruiter screen|phone screen|onsite)\b/.test(text) && !/\b(mock|practice|prepare|prep|rehearse)\b/.test(text)) derived.interviews += 1;
      else if (/\b(response|reply|callback|call back|heard back)\b/.test(text)) derived.responses += 1;
      else if (/\b(apply|application|submit(?:ted)? resume|send resume)\b/.test(text)) derived.applications += 1;
    }
  }
  return Object.fromEntries(Object.keys(derived).map((key) => {
    const saved = Number(stored?.[key]);
    return [key, Number.isFinite(saved) && saved >= 0 ? Math.round(saved) : derived[key]];
  }));
}

function planRationale(goal, plan) {
  const cleanGoal = String(goal || plan?.milestone_90day || 'this 90-day goal').trim().replace(/[.!?]+$/, '').slice(0, 150);
  const weeks = plan?.weeks || [], firstTheme = String(weeks[0]?.theme || 'a focused first action').trim(), lastTheme = weeks.length > 1 ? String(weeks.at(-1)?.theme || 'a measurable outcome').trim() : 'the 90-day milestone';
  return `Built around “${cleanGoal},” sequencing weekly action from ${firstTheme} through ${lastTheme}.`;
}

function isCareerPlanData(answers, plan, goal) {
  const signals = [answers?.category_key, answers?.category, answers?.goal_area, plan?.domain_label, goal]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return /\b(career|job(?:\s+search|\s+hunting)?|employment|promotion|professional|role|position|resume|interview|product manager|data scientist|software engineer)\b/.test(signals);
}

function relationshipPlanModeData(answers, plan, goal) {
  const relationshipCategory = /relationship|social/.test([answers?.category_key, answers?.category].filter(Boolean).join(' ').toLowerCase());
  const signals = [answers?.current_stage, answers?.outcome_type, goal, answers?.process_vision, answers?.action_types, answers?.first_week, plan?.domain_label, plan?.milestone_90day]
    .flat().filter(Boolean).join(' ').toLowerCase();
  if (/improve communication|repair (?:a|my|our) relationship|deepen (?:an|my|our) existing relationship|set (?:and maintain )?(?:an )?(?:important )?boundary/.test(signals)) return '';
  if (/dating|date\b|romantic|boyfriend|girlfriend|partner|single|prospect|mutual (?:attraction|interest)|love life|marriage|husband|wife|meet (?:someone|a compatible|men|women)|find (?:someone|a partner|a boyfriend|a girlfriend|love)|men\b|women\b|脱单|男朋友|女朋友|约会|伴侣|结婚/.test(signals)) return 'dating';
  if (/social life|social circle|friend|friendship|community|new city|reciprocal connection|belong|社交|朋友/.test(signals)) return 'social';
  return relationshipCategory ? 'social' : '';
}

function cleanFunnelMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  return Object.fromEntries(FUNNEL_METRIC_KEYS.filter((key) => Object.hasOwn(metrics, key)).map((key) => [key, Math.max(0, Math.floor(Number(metrics[key]) || 0))]));
}

async function track(eventName, userId, email, properties, serviceRoleKey) {
  await fetch(`${SUPABASE_URL}/rest/v1/mks_events`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ event_name: eventName, user_id: userId || null, email: email || null, properties }),
  }).catch(() => {});
}

function ownerState(record) {
  const access = record?.goal_data?._accountability;
  return {
    active: Boolean(access?.token_hash),
    created_at: access?.created_at || null,
    messages: (record?.goal_data?._accountability_messages || []).slice(-20).reverse(),
    progress: record?.goal_data?._accountability_progress || null,
    funnel_metrics: record?.goal_data?._funnel_metrics || null,
    custom_tasks: record?.goal_data?._custom_tasks || {},
    task_metrics: record?.goal_data?._task_metrics || {},
    task_schedules: record?.goal_data?._task_schedules || {},
    adjustment_history: (record?.goal_data?._weekly_adjustments || []).slice(-20).map((entry) => ({
      from_week: Math.max(1, Number(entry?.from_week) || 1),
      adjusted_week: Math.max(1, Number(entry?.adjusted_week) || 1),
      feedback: {
        result: String(entry?.feedback?.result || '').slice(0, 1200),
        completed_actions: Array.isArray(entry?.feedback?.completed_actions)
          ? entry.feedback.completed_actions.map((value) => String(value).slice(0, 500)).slice(0, 20)
          : [],
      },
    })),
  };
}

async function buddyView(record, serviceRoleKey) {
  const answers = record.goal_data || {}, plan = record.plan || {}, progress = answers._accountability_progress || {};
  const access = await getPlanAccess(record.user_id, serviceRoleKey);
  const visibleWeeks = access.unlocked ? (plan.weeks || []) : (plan.weeks || []).slice(0, 1);
  const startCandidate = answers.start_date || answers.createdAt || record.generated_at;
  const parsedStart = new Date(startCandidate);
  const startDate = Number.isNaN(parsedStart.getTime()) ? new Date(record.generated_at || Date.now()) : parsedStart;
  const goal = answers.goal || plan.milestone_90day || 'A meaningful 90-day goal';
  const isCareerPlan = isCareerPlanData(answers, plan, goal);
  const relationshipMode = relationshipPlanModeData(answers, plan, goal);
  const storedFunnel = cleanFunnelMetrics(answers._funnel_metrics);
  return {
    owner_name: answers._buddy_match_profile?.first_name || answers._accountability?.owner_name || 'Your buddy',
    goal,
    original_goal: goal,
    milestone: plan.milestone_90day || answers.goal || '',
    rationale: planRationale(goal, { ...plan, weeks: visibleWeeks }),
    funnel_kind: isCareerPlan ? 'career' : relationshipMode,
    funnel_metrics: isCareerPlan ? deriveCareerFunnel(visibleWeeks, progress.completed || {}, answers._funnel_metrics) : (relationshipMode ? storedFunnel : null),
    plan_length_weeks: Math.max(1, (plan.weeks || []).length || 12),
    start_date: startDate.toISOString().slice(0, 10),
    completed: progress.completed || {},
    estimates: buildTaskEstimates(plan, answers._task_estimates),
    messages: (answers._accountability_messages || []).slice(-30).reverse().map((entry) => ({
      name: String(entry.name || 'Accountability buddy').slice(0, 60),
      message: String(entry.message || '').slice(0, 500),
      created_at: entry.created_at,
    })),
    completed_count: Number(progress.completed_count) || 0,
    total_tasks: access.unlocked ? (Number(progress.total_tasks) || visibleWeeks.flatMap((week) => week.actions || []).length) : visibleWeeks.flatMap((week) => week.actions || []).length,
    updated_at: progress.updated_at || record.generated_at,
    weeks: visibleWeeks.map((week, index) => ({ week: week.week || index + 1, theme: week.theme || '', target: week.target || '', actions: week.actions || [] })),
  };
}

async function findMatch(userId, profile, serviceRoleKey) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=neq.${userId}&goal_data->_buddy_match_profile->>status=eq.waiting&select=user_id,email,goal_data,plan,generated_at&order=generated_at.asc&limit=50`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`Match query failed (${response.status})`);
  const candidates = await response.json();
  return candidates.find((candidate) => candidate.goal_data?._buddy_match_profile?.category === profile.category && candidate.goal_data?._buddy_match_profile?.cadence === profile.cadence)
    || null;
}

async function stateWithMatch(record, serviceRoleKey) {
  const state = ownerState(record), profile = record?.goal_data?._buddy_match_profile, match = record?.goal_data?._buddy_match;
  if (match?.partner_user_id) {
    const partner = await getRecordByUser(match.partner_user_id, serviceRoleKey);
    const reciprocal = partner?.goal_data?._buddy_match?.partner_user_id === record.user_id;
    state.match = reciprocal ? { status: 'matched', cadence: profile?.cadence || 'weekly', partner: await buddyView(partner, serviceRoleKey) } : { status: 'waiting', cadence: profile?.cadence || 'weekly' };
  } else if (profile?.status === 'waiting') state.match = { status: 'waiting', cadence: profile.cadence || 'weekly' };
  else state.match = { status: 'inactive' };
  return state;
}

function cleanCompleted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, checked]) => [String(key).slice(0, 80), Boolean(checked)]));
}

function cleanCustomTasks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [weekKey, tasks] of Object.entries(value).slice(0, 20)) {
    if (!/^week-\d{1,2}$/.test(weekKey) || !Array.isArray(tasks)) continue;
    clean[weekKey] = tasks.slice(0, 20).map((task, index) => ({
      id: String(task?.id || `custom-${index}`).slice(0, 80),
      text: String(task?.text || '').trim().slice(0, 180),
    })).filter(task => task.text);
  }
  return clean;
}

function cleanTaskMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [key, metric] of Object.entries(value).slice(0, 500)) {
    if (!metric || typeof metric !== 'object' || Array.isArray(metric)) continue;
    const target = Math.max(0, Number(metric.target) || 0), current = Math.max(0, Number(metric.current) || 0);
    if (!target) continue;
    clean[String(key).slice(0, 100)] = { current: Math.min(current, target), target, unit: String(metric.unit || '').slice(0, 40) };
  }
  return clean;
}

function cleanTaskSchedules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [key, schedule] of Object.entries(value).slice(0, 500)) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) continue;
    const date = String(schedule.date || '').slice(0, 10), time = String(schedule.time || '').slice(0, 5), duration = Math.max(5, Math.min(480, Number(schedule.duration) || 30));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) continue;
    clean[String(key).slice(0, 100)] = { date, time, duration };
  }
  return clean;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Accountability is not configured' });

  try {
    const user = await getUser(req.headers.authorization, serviceRoleKey);
    if (req.method === 'GET') {
      if (user) {
        const record = await getRecordByUser(user.id, serviceRoleKey);
        return res.status(200).json(await stateWithMatch(record, serviceRoleKey));
      }
      const record = await getRecordByShareToken(req.query?.token, serviceRoleKey);
      if (!record) return res.status(404).json({ error: 'This buddy link is invalid or has been turned off.' });
      return res.status(200).json(await buddyView(record, serviceRoleKey));
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.action === 'message') {
      const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
      const now = Date.now(), rate = messageRateLimit.get(ip) || { start: now, count: 0 };
      if (now - rate.start > 3_600_000) { rate.start = now; rate.count = 0; }
      rate.count += 1; messageRateLimit.set(ip, rate);
      if (rate.count > 20) return res.status(429).json({ error: 'Too many messages. Please try again later.' });
      const record = await getRecordByShareToken(body.token, serviceRoleKey);
      if (!record) return res.status(404).json({ error: 'This buddy link is invalid or has been turned off.' });
      const name = String(body.name || 'Accountability buddy').trim().slice(0, 60) || 'Accountability buddy';
      const message = String(body.message || '').trim().slice(0, 500);
      if (!message) return res.status(400).json({ error: 'Write a short message first.' });
      const entry = { name, message, created_at: new Date().toISOString() };
      const messages = [...(record.goal_data?._accountability_messages || []), entry].slice(-30);
      await saveGoalData(record.user_id, { ...(record.goal_data || {}), _accountability_messages: messages }, serviceRoleKey);
      await track('buddy_encouragement_sent', record.user_id, record.email, {}, serviceRoleKey);
      return res.status(201).json({ sent: true, message: entry });
    }

    if (!user) return res.status(401).json({ error: 'Sign in required' });
    const record = await getRecordByUser(user.id, serviceRoleKey);
    if (!record?.plan) return res.status(404).json({ error: 'Create a plan before inviting a buddy.' });
    const goalData = record.goal_data || {};

    if (body.action === 'create') {
      const token = crypto.randomBytes(24).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const fullName = String(user.user_metadata?.full_name || user.user_metadata?.name || '').trim();
      const ownerName = String(user.user_metadata?.given_name || fullName.split(/\s+/)[0] || 'Your buddy').slice(0, 60);
      const access = { token_hash: tokenHash, owner_name: ownerName, created_at: new Date().toISOString() };
      await saveGoalData(user.id, { ...goalData, _accountability: access }, serviceRoleKey);
      await track('accountability_link_created', user.id, user.email, {}, serviceRoleKey);
      return res.status(201).json({ active: true, share_url: `${origin}/buddy?token=${encodeURIComponent(token)}`, created_at: access.created_at });
    }

    if (body.action === 'join_pool') {
      if (body.consent !== true) return res.status(400).json({ error: 'Confirm what will be shared before joining the match pool.' });
      if (goalData._buddy_match?.partner_user_id) return res.status(200).json({ match: (await stateWithMatch(record, serviceRoleKey)).match });
      const cadence = ['weekly', 'twice_weekly'].includes(body.cadence) ? body.cadence : 'weekly';
      const fullName = String(user.user_metadata?.full_name || user.user_metadata?.name || '').trim();
      const firstName = String(user.user_metadata?.given_name || fullName.split(/\s+/)[0] || 'Lucky member').slice(0, 60);
      const profile = { status: 'waiting', category: String(goalData.category || 'Something else').slice(0, 80), cadence, timezone: String(body.timezone || 'UTC').slice(0, 80), first_name: firstName, joined_at: new Date().toISOString() };
      await saveGoalData(user.id, { ...goalData, _buddy_match_profile: profile, _buddy_match: null }, serviceRoleKey);
      const candidate = await findMatch(user.id, profile, serviceRoleKey);
      if (!candidate) { await track('accountability_match_requested', user.id, user.email, { category: profile.category, cadence }, serviceRoleKey); return res.status(200).json({ match: { status: 'waiting', cadence } }); }
      const matchedAt = new Date().toISOString();
      const candidateProfile = { ...candidate.goal_data._buddy_match_profile, status: 'matched' };
      await saveGoalData(candidate.user_id, { ...candidate.goal_data, _buddy_match_profile: candidateProfile, _buddy_match: { partner_user_id: user.id, matched_at: matchedAt } }, serviceRoleKey);
      try { await saveGoalData(user.id, { ...goalData, _buddy_match_profile: { ...profile, status: 'matched' }, _buddy_match: { partner_user_id: candidate.user_id, matched_at: matchedAt } }, serviceRoleKey); }
      catch (error) { await saveGoalData(candidate.user_id, { ...candidate.goal_data, _buddy_match_profile: { ...candidate.goal_data._buddy_match_profile, status: 'waiting' }, _buddy_match: null }, serviceRoleKey).catch(() => {}); throw error; }
      await track('accountability_match_created', user.id, user.email, { category: profile.category, cadence }, serviceRoleKey);
      return res.status(200).json({ match: { status: 'matched', cadence, partner: await buddyView(candidate, serviceRoleKey) } });
    }

    if (body.action === 'leave_pool') {
      const match = goalData._buddy_match;
      if (match?.partner_user_id) {
        const partner = await getRecordByUser(match.partner_user_id, serviceRoleKey);
        if (partner?.goal_data?._buddy_match?.partner_user_id === user.id) await saveGoalData(partner.user_id, { ...partner.goal_data, _buddy_match_profile: { ...(partner.goal_data._buddy_match_profile || {}), status: 'waiting' }, _buddy_match: null }, serviceRoleKey);
      }
      await saveGoalData(user.id, { ...goalData, _buddy_match_profile: { ...(goalData._buddy_match_profile || {}), status: 'inactive' }, _buddy_match: null }, serviceRoleKey);
      return res.status(200).json({ match: { status: 'inactive' } });
    }

    if (body.action === 'matched_message') {
      const partnerId = goalData._buddy_match?.partner_user_id;
      if (!partnerId) return res.status(404).json({ error: 'No internal buddy match is active.' });
      const partner = await getRecordByUser(partnerId, serviceRoleKey);
      if (partner?.goal_data?._buddy_match?.partner_user_id !== user.id) return res.status(404).json({ error: 'This buddy match is no longer active.' });
      const message = String(body.message || '').trim().slice(0, 500);
      if (!message) return res.status(400).json({ error: 'Write a short message first.' });
      const profileName = goalData._buddy_match_profile?.first_name || 'Your Lucky buddy';
      const entry = { name: profileName, message, source: 'internal_match', created_at: new Date().toISOString() };
      const messages = [...(partner.goal_data?._accountability_messages || []), entry].slice(-30);
      await saveGoalData(partner.user_id, { ...partner.goal_data, _accountability_messages: messages }, serviceRoleKey);
      await track('buddy_encouragement_sent', partner.user_id, partner.email, { source: 'internal_match' }, serviceRoleKey);
      return res.status(201).json({ sent: true });
    }

    if (body.action === 'progress') {
      const completed = cleanCompleted(body.completed);
      const progress = { completed, completed_count: Object.values(completed).filter(Boolean).length, total_tasks: Math.max(0, Number(body.total_tasks) || 0), updated_at: new Date().toISOString() };
      const taskEstimates = buildTaskEstimates(record.plan, goalData._task_estimates);
      const customTasks = body.custom_tasks === undefined ? (goalData._custom_tasks || {}) : cleanCustomTasks(body.custom_tasks);
      const taskMetrics = body.task_metrics === undefined ? (goalData._task_metrics || {}) : cleanTaskMetrics(body.task_metrics);
      const taskSchedules = body.task_schedules === undefined ? (goalData._task_schedules || {}) : cleanTaskSchedules(body.task_schedules);
      const funnelMetrics = body.funnel_metrics === undefined ? goalData._funnel_metrics : cleanFunnelMetrics(body.funnel_metrics);
      await saveGoalData(user.id, { ...goalData, _accountability_progress: progress, _task_estimates: taskEstimates, _funnel_metrics: funnelMetrics, _custom_tasks: customTasks, _task_metrics: taskMetrics, _task_schedules: taskSchedules }, serviceRoleKey);
      return res.status(200).json({ synced: true, progress });
    }

    if (body.action === 'disable') {
      await saveGoalData(user.id, { ...goalData, _accountability: null }, serviceRoleKey);
      await track('accountability_link_disabled', user.id, user.email, {}, serviceRoleKey);
      return res.status(200).json({ active: false });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('accountability failed:', error);
    return res.status(500).json({ error: 'Accountability request failed' });
  }
}
