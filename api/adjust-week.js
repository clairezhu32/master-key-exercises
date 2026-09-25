import { getPlanAccess, getUserFromToken, isAllowedOrigin, requestOrigin, SUPABASE_URL } from '../lib/plan-access.js';

export const config = { maxDuration: 60 };

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FUNNEL_STAGES = ['targets', 'access_points', 'outreach', 'gap_closing', 'core_prep', 'funnel_metrics', 'close'];
const rateLimitMap = new Map();

const WEEK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    week: { type: 'INTEGER' },
    funnel_stage: { type: 'STRING', enum: FUNNEL_STAGES },
    theme: { type: 'STRING' },
    target: { type: 'STRING', description: 'A concrete, measurable outcome for this week.' },
    actions: {
      type: 'ARRAY',
      description: 'Exactly 3 concrete actions sized to the user’s available time.',
      items: { type: 'STRING' },
    },
    exercise_part: { type: 'INTEGER', description: 'A Lucky Method step from 1 through 6.' },
    exercise_reason: { type: 'STRING' },
  },
  required: ['week', 'funnel_stage', 'theme', 'target', 'actions', 'exercise_part', 'exercise_reason'],
};

function serviceHeaders(serviceRoleKey, extra = {}) {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, ...extra };
}

function cleanFeedback(feedback = {}) {
  const clean = {};
  for (const key of ['status', 'result', 'missed', 'change']) clean[key] = String(feedback[key] || '').trim().slice(0, 1200);
  clean.completed_actions = Array.isArray(feedback.completed_actions) ? feedback.completed_actions.map(String).slice(0, 20) : [];
  clean.incomplete_actions = Array.isArray(feedback.incomplete_actions) ? feedback.incomplete_actions.map(String).slice(0, 20) : [];
  return clean;
}

async function generateAdjustedWeek(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AI planning is not configured'), { status: 500 });
  const careerRule = context.answers.category_key === 'career' ? `
This is a career plan. Keep three execution lanes active in parallel: (1) verified networking/referral outreach and follow-up, with Meta Muse only as an optional assistant for organizing the user's own contacts and drafting user-reviewed messages; (2) truthful role-specific resume tailoring tied to actual application submissions; and (3) scheduled interview practice with a measurable output. The three actions should normally map one-to-one to these lanes.` : '';
  const prompt = `Revise ONLY the next week of a personalized 90-day action plan using the user's completed weekly scorecard.

Protect the original 90-day goal. Respond to what happened in reality: keep what worked, reduce or replace what did not, and apply the user's requested change. Do not punish missed work by stacking it on top of a full new week. Keep exactly 3 actions, each specific, measurable, and feasible within the user's stated weekly hours. Preserve continuity with later weeks without rewriting them. Do not claim guaranteed outcomes.${careerRule}

Goal and onboarding answers:
${JSON.stringify(context.answers)}

Current week:
${JSON.stringify(context.currentWeek)}

User feedback and actual execution:
${JSON.stringify(context.feedback)}

Original next week to revise:
${JSON.stringify(context.nextWeek)}

Following weeks for continuity only:
${JSON.stringify(context.followingWeeks)}

Return the revised next-week object. Its week number must remain ${context.nextWeek.week}.`;

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are Lucky, a practical execution coach. Revise plans from honest weekly evidence while preserving the user’s meaningful goal.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: WEEK_SCHEMA, maxOutputTokens: 1800 },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`adjust-week Gemini ${response.status}: ${detail}`);
    const message = response.status === 429 ? 'Weekly adjustment is temporarily rate-limited. Please try again shortly.' : 'Lucky could not adjust next week right now.';
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw Object.assign(new Error('Lucky returned an incomplete weekly adjustment.'), { status: 502 });
  let week;
  try { week = JSON.parse(text); } catch { throw Object.assign(new Error('Lucky returned an invalid weekly adjustment.'), { status: 502 }); }
  if (!Array.isArray(week.actions) || week.actions.length !== 3) throw Object.assign(new Error('Lucky returned an incomplete weekly adjustment.'), { status: 502 });
  return { ...week, week: context.nextWeek.week };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAllowedOrigin(requestOrigin(req))) return res.status(403).json({ error: 'Forbidden' });

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return res.status(500).json({ error: 'Weekly adjustment is not configured' });
  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const now = Date.now(), entry = rateLimitMap.get(user.id) || { count: 0, startedAt: now };
  if (now - entry.startedAt > 3_600_000) { entry.count = 0; entry.startedAt = now; }
  entry.count += 1; rateLimitMap.set(user.id, entry);
  if (entry.count > 12) return res.status(429).json({ error: 'Too many weekly adjustments. Please try again later.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Invalid request body' }); }
  const currentWeekNumber = Number(body.current_week);
  const feedback = cleanFeedback(body.feedback);
  if (!Number.isInteger(currentWeekNumber) || currentWeekNumber < 1 || currentWeekNumber >= 12) return res.status(400).json({ error: 'Choose a week from 1 through 11.' });
  if (!feedback.result || !feedback.missed || !feedback.change) return res.status(400).json({ error: 'Complete all three weekly scorecard questions before adjusting next week.' });

  try {
    const access = await getPlanAccess(user.id, serviceRoleKey);
    if (!access.unlocked) return res.status(403).json({ error: 'Unlock the full plan before adjusting future weeks.' });
    const recordResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${encodeURIComponent(user.id)}&select=goal_data,plan&limit=1`, { headers: serviceHeaders(serviceRoleKey) });
    if (!recordResponse.ok) throw new Error(`Plan query failed (${recordResponse.status})`);
    const record = (await recordResponse.json())[0];
    const weeks = record?.plan?.weeks;
    if (!record?.plan || !Array.isArray(weeks)) return res.status(404).json({ error: 'No saved 90-day plan was found.' });
    const currentIndex = weeks.findIndex((week, index) => Number(week.week || index + 1) === currentWeekNumber);
    if (currentIndex < 0 || currentIndex >= weeks.length - 1) return res.status(400).json({ error: 'There is no following week to adjust.' });

    const nextWeek = weeks[currentIndex + 1];
    const adjustedWeek = await generateAdjustedWeek({
      answers: Object.fromEntries(Object.entries(record.goal_data || {}).filter(([key]) => !key.startsWith('_'))),
      currentWeek: weeks[currentIndex],
      nextWeek,
      followingWeeks: weeks.slice(currentIndex + 2, currentIndex + 4),
      feedback,
    });
    const adjustedPlan = { ...record.plan, weeks: weeks.map((week, index) => index === currentIndex + 1 ? adjustedWeek : week) };
    const history = Array.isArray(record.goal_data?._weekly_adjustments) ? record.goal_data._weekly_adjustments.slice(-19) : [];
    const goalData = { ...record.goal_data, _weekly_adjustments: [...history, { from_week: currentWeekNumber, adjusted_week: adjustedWeek.week, feedback, adjusted_at: new Date().toISOString() }] };
    const saveResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      headers: serviceHeaders(serviceRoleKey, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ goal_data: goalData, plan: adjustedPlan }),
    });
    if (!saveResponse.ok) throw new Error(`Plan update failed (${saveResponse.status})`);
    return res.status(200).json({ week: adjustedWeek, adjusted_week_number: adjustedWeek.week });
  } catch (error) {
    console.error(`adjust-week failed for ${user.id}: ${error.message}`);
    return res.status(error.status || 500).json({ error: error.message || 'Could not adjust next week' });
  }
}
