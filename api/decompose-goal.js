import { createPlanPreview, getPlanAccess } from '../lib/plan-access.js';
import { getOnboardingTree } from '../lib/onboarding-tree.js';

// A full 12-week, 7-stage funnel plan (maxOutputTokens: 8000) routinely takes
// Gemini well past Vercel's old unconfigured default duration — without this,
// the function gets killed mid-generation and the request just hangs from
// the browser's perspective until it times out on its own.
export const config = {
  maxDuration: 60,
};

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 3_600_000;
const RATE_MAX = 30;

// Defaults to the "-latest" alias, but production is pinned to a specific
// version via the GEMINI_MODEL env var (currently gemini-3.6-flash) as of
// 2026-08-20: the alias kept silently drifting to whatever newer model
// Google was rolling out, and those newer models were seeing sustained
// "high demand" 503s (confirmed in live logs: 100% failure rate across
// every attempt for one account, individual calls up to 35s) — a genuine
// capacity issue that persisted even after enabling billing, since billing
// fixes quota ceilings, not model-level congestion. Pinning at least stops
// it from silently moving to whatever's currently overloaded next.
// (First pinned to gemini-2.5-flash, which turned out to be a dead end —
// Google's own 404 response said it's "no longer available to new users"
// and named gemini-3.6-flash as the replacement.)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Identity-change themes adapted from the attached Chase Hughes transcript.
// They are framed as reflective behavior-design practices, not clinical claims.
const PART_THEMES = [
  'Target Acquisition',
  'Threat Modeling',
  'Identity Engineering',
  'Environmental Sabotage',
  'Mammalian Brain Reprogramming (FATE)',
  'FEAR Protocol',
  'Identity Integration',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin)) return true;
  const custom = process.env.ALLOWED_ORIGIN;
  if (custom && origin === custom) return true;
  return false;
}

function getRequestOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const fallbackProtocol = host.startsWith('localhost') ? 'http' : 'https';
  const protocol = String(req.headers['x-forwarded-proto'] || fallbackProtocol).split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
}

const SUPABASE_URL = 'https://hvuhpnvsxhvvsisrsmaq.supabase.co';

async function getUserFromToken(authHeader, serviceRoleKey) {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey },
  });
  if (!res.ok) return null;
  return res.json();
}

const PLAN_GENERATION_LIMIT = 3;
const UNLIMITED_TEST_EMAILS = new Set(['clairehzhu@gmail.com']);
const isUnlimitedTester = email => UNLIMITED_TEST_EMAILS.has(String(email || '').trim().toLowerCase());

// Ensure the account has a generation row, then read its durable usage count.
// Older records predate the counter, so an existing saved plan counts as the
// first generation automatically.
async function claimGeneration(userId, email, serviceRoleKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ user_id: userId, email }),
  });
  if (!res.ok) return null;
  const stateRes = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}&select=goal_data,plan&limit=1`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!stateRes.ok) return null;
  const [record] = await stateRes.json();
  const storedCount = Number(record?.goal_data?._generation_count);
  const used = Number.isFinite(storedCount) ? storedCount : record?.plan ? 1 : 0;
  const unlimited = isUnlimitedTester(email);
  return { used, remaining: unlimited ? null : Math.max(0, PLAN_GENERATION_LIMIT - used), allowed: unlimited || used < PLAN_GENERATION_LIMIT, unlimited, goalData: record?.goal_data || {} };
}

// mks_goal_generations is also the durable copy of the plan itself:
// generation can take 40-50s+ under sustained Gemini overload, and a
// client-side page reload/navigation mid-request could otherwise silently
// lose a plan that had actually succeeded, since it previously only ever
// lived in the browser's localStorage. This write also advances the account's
// successful-generation count, so a failed write must not report success.
async function saveGenerationResult(userId, goalData, plan, generationCount, serviceRoleKey, existingGoalData = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ goal_data: { ...existingGoalData, ...goalData, _generation_count: generationCount }, plan, generated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.error(`Failed to save generation result for user ${userId}: ${res.status}`);
  return res.ok;
}

const FUNNEL_STAGE_KEYS = ['targets', 'access_points', 'outreach', 'gap_closing', 'core_prep', 'funnel_metrics', 'close'];

// Gemini's Schema object uses uppercase type names and doesn't support
// additionalProperties — it's a distinct (OpenAPI-derived) format from the
// JSON Schema draft OpenAI/Anthropic use.
const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plan_mode: { type: 'STRING', enum: ['action_mindset'], description: 'Always action_mindset.' },
    domain_label: { type: 'STRING', description: "Short label for the goal domain, e.g. 'Career / Job Search', 'Business Launch', 'Marathon Training'." },
    summary: { type: 'STRING', description: "1-2 sentences tying the plan to the person's stated reason for pursuing it." },
    insight: { type: 'STRING', description: 'One sharp, non-obvious strategic insight specific to this goal and this obstacle — not generic motivational text.' },
    milestone_90day: { type: 'STRING', description: 'A concrete 90-day outcome paired with the identity the person is becoming while pursuing it. Use an observable funnel result rather than merely listing activities whenever the goal depends on conversion through stages.' },
    identity_gap: {
      type: 'OBJECT',
      description: 'A specific diagnosis of the distance between the current identity and desired identity. Infer meaningful gaps; do not merely repeat the answers.',
      properties: {
        motivation: { type: 'STRING', description: 'The person’s primary reason for the transition and how it should shape the identity change.' },
        from_identity: { type: 'STRING', description: 'A concise description of the current identity and its default operating mode.' },
        to_identity: { type: 'STRING', description: 'A concise description of the desired identity and its default operating mode.' },
        transferable_strengths: { type: 'ARRAY', description: 'Exactly 3 strengths from the current identity that remain valuable in the new identity.', items: { type: 'STRING' } },
        practical_gaps: { type: 'ARRAY', description: 'Exactly 3 specific capability, proof, positioning, access or execution gaps that the action track should close. For career transitions, infer them from the current and target roles.', items: { type: 'STRING' } },
        gaps: { type: 'ARRAY', description: 'Exactly 3 specific identity-level gaps, each written as a shift from an old default to a new default. Focus on ownership, judgment, voice, standards, uncertainty, relationships or self-concept—not credentials or task lists.', items: { type: 'STRING' } },
      },
      required: ['motivation', 'from_identity', 'to_identity', 'transferable_strengths', 'practical_gaps', 'gaps'],
    },
    lucky_method: {
      type: 'ARRAY',
      description: 'Exactly 7 personalized steps in transcript order. Step 7 is Identity Integration, a faithful label derived from the transcript’s closing description because the speaker does not explicitly name a distinct seventh step.',
      items: {
        type: 'OBJECT',
        properties: {
          step: { type: 'INTEGER', description: '1 through 7.' },
          title: { type: 'STRING', description: 'Use the exact canonical Lucky Method title for this step.' },
          guidance: { type: 'STRING', description: 'One concise, personalized explanation of how this step applies to the person’s goal and current situation.' },
          action: { type: 'STRING', description: 'One short mindset practice that supports the real-world actions in this step.' },
        },
        required: ['step', 'title', 'guidance', 'action'],
      },
    },
    funnel: {
      type: 'OBJECT',
      description: 'A 7-stage strategic funnel adapted to this specific goal domain, modeled on: targets -> access points -> outreach -> gap-closing -> core preparation -> funnel metrics/iteration -> close.',
      properties: {
        targets: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING', description: 'What "targets" means for this specific goal and how to build the list.' },
            items: {
              type: 'ARRAY',
              description: 'Provide 5 to 12 specific targets.',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'A specific target or a specific, well-defined target archetype (e.g. a real well-known company/organization if genuinely relevant, or a precise criteria-based category — never a fabricated specific entity presented as real).' },
                  why_it_fits: { type: 'STRING' },
                },
                required: ['name', 'why_it_fits'],
              },
            },
          },
          required: ['description', 'items'],
        },
        access_points: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING', description: 'Where and how the person can consistently encounter relevant people, opportunities or channels for this goal.' },
            items: {
              type: 'ARRAY',
              description: 'Provide 3 to 10 access points.',
              items: {
                type: 'OBJECT',
                properties: {
                  role_to_reach: { type: 'STRING', description: "The type of person/channel to reach, e.g. 'Hiring manager for the team', 'Recruiter for the function', never a fabricated named individual." },
                  how_to_find_them: { type: 'STRING', description: 'A concrete, actionable method to identify a real person or channel in this role.' },
                },
                required: ['role_to_reach', 'how_to_find_them'],
              },
            },
          },
          required: ['description', 'items'],
        },
        outreach: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING' },
            first_message_script: { type: 'STRING', description: 'A ready-to-send outreach message template, personalized with [bracketed placeholders] for the person to fill in.' },
            follow_up_script: { type: 'STRING', description: 'A ready-to-send follow-up template for no response.' },
            cadence: { type: 'STRING', description: 'How often and in what pattern to send outreach and follow-ups.' },
          },
          required: ['description', 'first_message_script', 'follow_up_script', 'cadence'],
        },
        gap_closing: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING' },
            gaps: {
              type: 'ARRAY',
              description: 'Provide 3 to 6 gaps.',
              items: {
                type: 'OBJECT',
                properties: {
                  gap: { type: 'STRING', description: 'A specific gap between where they are now and what the target expects, inferred from their stated goal/obstacle.' },
                  why_it_matters: { type: 'STRING' },
                  resource: { type: 'STRING', description: 'A specific type of resource to close it (course, template, book, tool, practice method) — describe it concretely even if you cannot verify a live link.' },
                  action: { type: 'STRING', description: 'The concrete next action to close this gap.' },
                },
                required: ['gap', 'why_it_matters', 'resource', 'action'],
              },
            },
          },
          required: ['description', 'gaps'],
        },
        core_prep: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING', description: "What the 'make-or-break moment' is for this goal (interview, pitch, audition, negotiation, launch, race day, etc.) and how prep breaks down." },
            tasks: {
              type: 'ARRAY',
              description: 'Provide 4 to 8 tasks.',
              items: {
                type: 'OBJECT',
                properties: { task: { type: 'STRING' }, detail: { type: 'STRING' } },
                required: ['task', 'detail'],
              },
            },
          },
          required: ['description', 'tasks'],
        },
        funnel_metrics: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING', description: 'Define the outcome funnel and clearly distinguish controllable inputs from influenced conversion results.' },
            steps: {
              type: 'ARRAY',
              description: 'The ordered conversion funnel for this goal, e.g. outreach sent -> replies -> meetings -> next-round -> close. Provide 3 to 6 steps.',
              items: {
                type: 'OBJECT',
                properties: {
                  step_name: { type: 'STRING' },
                  benchmark: { type: 'STRING', description: 'A realistic target count or conversion rate for this step, stated as a number/range.' },
                },
                required: ['step_name', 'benchmark'],
              },
            },
            iteration_plan: { type: 'STRING', description: 'How and how often to review the funnel numbers and what to change at the weakest step.' },
          },
          required: ['description', 'steps', 'iteration_plan'],
        },
        close: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING' },
            checklist: {
              type: 'ARRAY',
              description: 'Provide 4 to 8 checklist items.',
              items: { type: 'STRING' },
            },
          },
          required: ['description', 'checklist'],
        },
      },
      required: FUNNEL_STAGE_KEYS,
    },
    weeks: {
      type: 'ARRAY',
      description: 'Return exactly 12 weeks for every goal. Each week combines measurable real-world progress with one mindset practice and an identity-evidence prompt.',
      items: {
        type: 'OBJECT',
        properties: {
          week: { type: 'INTEGER', description: 'Sequential week number, 1 through 12.' },
          framework_step: { type: 'INTEGER', description: 'The identity framework step emphasized this week, from 1 through 7. Weeks 1-7 must map directly to Steps 1-7.' },
          funnel_stage: { type: 'STRING', enum: FUNNEL_STAGE_KEYS, description: 'Which funnel stage this week is primarily advancing.' },
          theme: { type: 'STRING' },
          target: { type: 'STRING', description: 'A concise summary connecting this week’s measurable external outcome to its internal identity shift.' },
          action_outcome: { type: 'STRING', description: 'The tangible, measurable funnel result to aim for by the end of the week. This must describe movement or conversion produced by the actions, not simply restate an activity.' },
          mindset_shift: { type: 'STRING', description: 'A specific shift written as “From [old default] to [new default].”' },
          identity_evidence: { type: 'STRING', description: 'One short question asking what observable action or result this week proves the emerging identity.' },
          actions: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Exactly 4 checkable items in this order: 3 concrete real-world tasks prefixed “Action:” and 1 identity or emotional practice prefixed “Mindset:”. Make action tasks specific, feasible within the stated capacity, and measurable by a number, deliverable, or scheduled event.',
          },
          exercise_part: { type: 'INTEGER', description: 'The most relevant Lucky Method exercise step for this specific week, from 1 through 6.' },
          exercise_reason: { type: 'STRING', description: 'One concise sentence connecting this exercise to the week’s target, actions, or likely execution obstacle.' },
        },
        required: ['week', 'framework_step', 'funnel_stage', 'theme', 'target', 'action_outcome', 'mindset_shift', 'identity_evidence', 'actions', 'exercise_part', 'exercise_reason'],
      },
    },
    exercises: {
      type: 'ARRAY',
      description: 'Exactly 3 exercises.',
      items: {
        type: 'OBJECT',
        properties: {
          part: { type: 'INTEGER', description: '1 through 6, matching the Lucky Method exercise step.' },
          reason: { type: 'STRING', description: "Why this specific part's theme addresses this person's stated obstacle." },
        },
        required: ['part', 'reason'],
      },
    },
  },
  required: ['plan_mode', 'domain_label', 'summary', 'insight', 'milestone_90day', 'identity_gap', 'lucky_method', 'funnel', 'weeks', 'exercises'],
};

const ADJUSTED_WEEK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    week: { type: 'INTEGER' },
    framework_step: { type: 'INTEGER', description: 'Preserve the original framework step for this week, from 1 through 7.' },
    funnel_stage: { type: 'STRING', enum: FUNNEL_STAGE_KEYS },
    theme: { type: 'STRING' },
    target: { type: 'STRING', description: 'A concise summary connecting the measurable outcome to the mindset shift.' },
    action_outcome: { type: 'STRING', description: 'The tangible, measurable funnel result to aim for by the end of the week, distinct from the activities beneath it.' },
    mindset_shift: { type: 'STRING', description: 'A specific shift written as “From [old default] to [new default].”' },
    identity_evidence: { type: 'STRING', description: 'A question asking what observable action or result proves the emerging identity.' },
    actions: { type: 'ARRAY', description: 'Exactly 4 checkable items: 3 concrete tasks prefixed “Action:” and 1 mindset practice prefixed “Mindset:”.', items: { type: 'STRING' } },
    exercise_part: { type: 'INTEGER', description: 'A Lucky Method step from 1 through 6.' },
    exercise_reason: { type: 'STRING' },
  },
  required: ['week', 'framework_step', 'funnel_stage', 'theme', 'target', 'action_outcome', 'mindset_shift', 'identity_evidence', 'actions', 'exercise_part', 'exercise_reason'],
};

function isCareerPath({ category_key, category, goal } = {}) {
  const signals = [category_key, category, goal].filter(Boolean).join(' ').toLowerCase().replace(/[_-]+/g, ' ');
  return /\b(career|job(?:\s+search|\s+hunting)?|employment|promotion|professional|role|position|resume|interview|product manager|data scientist|software engineer)\b/.test(signals);
}

function cleanWeeklyFeedback(feedback = {}) {
  const clean = {};
  for (const key of ['status', 'result', 'missed', 'change']) clean[key] = String(feedback[key] || '').trim().slice(0, 1200);
  clean.completed_actions = Array.isArray(feedback.completed_actions) ? feedback.completed_actions.map(String).slice(0, 20) : [];
  clean.incomplete_actions = Array.isArray(feedback.incomplete_actions) ? feedback.incomplete_actions.map(String).slice(0, 20) : [];
  return clean;
}

async function generateAdjustedWeek(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AI planning is not configured'), { status: 500 });
  const prompt = `Revise ONLY the next week of a personalized 90-day action-and-mindset plan using the user's reflection.

Keep the same framework step, but use actual execution to improve feasibility. Return exactly 4 checkable items in order: (1-3) concrete real-world tasks prefixed “Action:” and (4) one identity, belief, or emotional-rehearsal practice prefixed “Mindset:”. Every action must create a number, deliverable, decision, conversation, scheduled event, or other observable result. The mindset item must directly support the actions rather than replace them. Also return a measurable action_outcome, a “From ... to ...” mindset_shift, and an identity_evidence question. action_outcome must describe the funnel conversion the tasks are intended to produce, not merely repeat an activity. For dating goals, optimize toward mutual-interest and repeat-date conversions; for social goals, optimize toward reciprocal repeat contact. Never treat one-sided pursuit or event attendance alone as success. Do not punish missed work by stacking more work. Preserve continuity without rewriting later weeks. Never claim that thoughts guarantee external outcomes or that these practices medically rewire the brain.

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

Return the revised next-week object. Its week number must remain ${context.nextWeek.week} and its framework_step must remain ${context.nextWeek.framework_step || 'the original value'}.`;
  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are Lucky, a practical behavior-change coach. Revise real-world actions and mindset support from honest weekly evidence without making clinical or guaranteed-outcome claims.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: ADJUSTED_WEEK_SCHEMA, maxOutputTokens: 1800 },
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
  if (!Array.isArray(week.actions) || week.actions.length !== 4) throw Object.assign(new Error('Lucky returned an incomplete weekly adjustment.'), { status: 502 });
  const cleanPrefix = value => String(value || '').replace(/^(?:action|mindset)\s*:\s*/i, '').trim();
  return {
    ...week,
    week: context.nextWeek.week,
    actions: [
      ...week.actions.slice(0, 3).map(item => `Action: ${cleanPrefix(item)}`),
      `Mindset: ${cleanPrefix(week.actions[3])}`,
    ],
  };
}

async function adjustNextWeek(user, body, serviceRoleKey) {
  const currentWeekNumber = Number(body.current_week);
  const feedback = cleanWeeklyFeedback(body.feedback);
  if (!Number.isInteger(currentWeekNumber) || currentWeekNumber < 1) throw Object.assign(new Error('Choose a valid completed week.'), { status: 400 });
  if (!feedback.result || !feedback.missed || !feedback.change) throw Object.assign(new Error('Complete all three weekly scorecard questions before adjusting next week.'), { status: 400 });
  const access = await getPlanAccess(user.id, serviceRoleKey);
  if (!access.unlocked) throw Object.assign(new Error('Unlock the full plan before adjusting future weeks.'), { status: 403 });
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const recordResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${encodeURIComponent(user.id)}&select=goal_data,plan&limit=1`, { headers });
  if (!recordResponse.ok) throw new Error(`Plan query failed (${recordResponse.status})`);
  const record = (await recordResponse.json())[0];
  const weeks = record?.plan?.weeks;
  if (!record?.plan || !Array.isArray(weeks)) throw Object.assign(new Error('No saved 90-day plan was found.'), { status: 404 });
  const currentIndex = weeks.findIndex((week, index) => Number(week.week || index + 1) === currentWeekNumber);
  if (currentIndex < 0 || currentIndex >= weeks.length - 1) throw Object.assign(new Error('There is no following week to adjust.'), { status: 400 });
  const nextWeek = weeks[currentIndex + 1];
  const adjustedWeek = await generateAdjustedWeek({
    answers: Object.fromEntries(Object.entries(record.goal_data || {}).filter(([key]) => !key.startsWith('_'))),
    currentWeek: weeks[currentIndex], nextWeek, followingWeeks: weeks.slice(currentIndex + 2, currentIndex + 4), feedback,
  });
  const adjustedPlan = { ...record.plan, weeks: weeks.map((week, index) => index === currentIndex + 1 ? adjustedWeek : week) };
  const history = Array.isArray(record.goal_data?._weekly_adjustments) ? record.goal_data._weekly_adjustments.slice(-19) : [];
  const goalData = { ...record.goal_data, _weekly_adjustments: [...history, { from_week: currentWeekNumber, adjusted_week: adjustedWeek.week, feedback, adjusted_at: new Date().toISOString() }] };
  const saveResponse = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ goal_data: goalData, plan: adjustedPlan }),
  });
  if (!saveResponse.ok) throw new Error(`Plan update failed (${saveResponse.status})`);
  return { week: adjustedWeek, adjusted_week_number: adjustedWeek.week };
}

function buildSystemPrompt() {
  const partList = PART_THEMES.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `You are Lucky, a practical behavior-change coach. Create a personalized 90-day action-and-mindset journey. The plan must help the person make observable progress toward the external goal while changing the identity, beliefs and emotional defaults that determine whether they sustain the work.

Use this causal loop throughout the plan: mindset shift -> real-world action -> observable evidence -> stronger identity -> better next action. Action is the backbone of the product; mindset supports execution and must never replace it. Aim for roughly 70% real-world action and 30% mindset work.

Follow this seven-step sequence from the supplied Chase Hughes transcript:
1. Target Acquisition — define a precise arrival condition the person can picture and recognize. For an identity transition, specify exactly who they are becoming and how that identity operates in an ordinary difficult moment.
2. Threat Modeling — create two vivid 10-year futures: the desired identity trajectory and the honest trajectory if the old identity remains unchanged. Then extend only the no-change trajectory to 20 years so the cumulative cost becomes visible. Cover work, money, relationships, energy, self-respect and missed possibilities only where relevant to the person's answers. Use calm, plausible contrast—not panic, invented disasters, shame or coercion.
3. Identity Engineering — define exactly three beliefs the new identity holds, three default ways it behaves, and three standards it does not negotiate. These are identity rules, not productivity quotas.
4. Environmental Sabotage — deliberately change safe, reversible environmental, language, visual, schedule or routine cues that trigger the old identity. “Sabotage” refers only to interrupting old cues, never harming the person or their responsibilities.
5. Mammalian Brain Reprogramming (FATE) — personalize Focus, Authority, Tribe and Emotion: what remains visible, which credible evidence or voice matters, who expects this identity, and how the future self becomes emotionally real.
6. FEAR Protocol — personalize Focus, Emotion, Agitation/novelty and Repetition. Use safe novelty and short repeated rehearsal until the identity feels familiar; never describe this as medical brain rewiring.
7. Identity Integration — consolidate the transcript’s closing outcome: the pattern stops feeling like something the person is forcing and begins to feel like who they are. The spoken transcript calls the framework seven steps but does not explicitly name a separate seventh step; use “Identity Integration” as the transparent, derived label for its concluding integration principle.

Return all seven in lucky_method in this exact order and personalize them with the person's own words. Set plan_mode to action_mindset.

Before building the weeks, diagnose the identity gap. Populate identity_gap with:
- the primary motivation for the change and how it changes the emphasis of the new identity;
- the current identity and how it habitually operates;
- the desired identity and how it must operate;
- exactly three strengths that transfer across the change;
- exactly three practical capability, proof, positioning, access or execution gaps that the action track will close;
- exactly three non-obvious identity shifts required.
For a role transition, reason about the actual difference in role identity. Example: Data Scientist -> Product Manager may require a shift from producing rigorous analysis and advising decisions to framing the problem, making tradeoffs under uncertainty, aligning people and owning the outcome. Do not treat the old identity as inferior. Do not reduce the gap to resume keywords, credentials or a generic confidence problem.
Motivation must materially change the diagnosis. If the motive is income, emphasize self-valuation, leverage, standards and permission to pursue compensation without equating money with worth. If it is impact, emphasize ownership, decisions and influence. If it is strengths, preserve and reposition transferable strengths. If it is interest, emphasize curiosity, permission to explore and intrinsic identification. If it is leadership, emphasize direction, responsibility and relationships. If it is lifestyle, emphasize boundaries, sustainability and a definition of success that protects life outside work.

The plan must contain exactly 12 weeks and follow this mindset sequence without reordering. The framework step shapes the week’s internal work, while the action track must still advance the external goal:
- Week 1 — Target Acquisition: define the precise new identity and arrival condition.
- Week 2 — Threat Modeling: contrast two specific 10-year futures, then extend the unchanged-identity trajectory to Year 20. The “Mindset:” item must explicitly include both Year 10 futures and the Year 20 cost of no identity change, then connect that contrast to one immediate action.
- Week 3 — Identity Engineering: write 3 beliefs, 3 defaults and 3 non-negotiable standards.
- Week 4 — Environmental Sabotage: interrupt cues that automatically reactivate the old identity.
- Week 5 — FATE: build Focus, Authority, Tribe and Emotion around the new identity.
- Week 6 — FEAR: combine Focus, Emotion, safe Agitation/novelty and Repetition.
- Week 7 — Identity Integration: notice when the new identity begins to feel natural and consolidate it.
- Week 8 — Repeat Target Acquisition with a more precise identity under real uncertainty.
- Week 9 — Repeat Threat Modeling without catastrophizing; revise the two Year 10 futures and the Year 20 no-change trajectory using actual experience from the first eight weeks.
- Week 10 — Deepen Identity Engineering using evidence gathered during the first nine weeks.
- Week 11 — Strengthen Environmental Sabotage and FATE where the old identity still has strong cues.
- Week 12 — Integrate FEAR and Identity Integration into a continuation ritual and a first-person identity declaration.
Set framework_step to 1,2,3,4,5,6,7,1,2,3,5,7 for Weeks 1 through 12 respectively.

Every week must include all of the following:
- action_outcome: one tangible result achievable that week and measurable by a number, deliverable, decision, conversation or scheduled event;
- mindset_shift: one specific “From [old default] to [new default]” statement tied to the week’s framework step;
- exactly 4 checkable actions in order: 3 prefixed “Action:” followed by 1 prefixed “Mindset:”;
- identity_evidence: one short question asking which observable action, decision or result proves the person is already practicing the new identity.

The weekly action_outcome and the 3 Action items serve different purposes. action_outcome is the measurable conversion result the week is trying to create; the Action items are controllable inputs that make that result more likely. Never fill action_outcome with a disguised activity such as “attend a hike” or “send three messages.” The 3 Action items must be specific to the actual goal, sequence logically across 12 weeks, and fit the person’s stated capacity. Do not use vague items such as “work on your goal,” “be more confident,” or “research opportunities.” Include a number, named deliverable or scheduled interaction whenever possible. The Mindset item must be short enough to complete and must make the external actions easier to start, sustain or learn from.

For career transitions, use the actual gap diagnosis to prescribe a balanced mix of target-role research, skill mapping, gap closing, proof-of-work, resume/LinkedIn positioning, networking, applications and interview rehearsal. Do not force all of these into every week; choose the highest-leverage actions for the current stage.

For dating goals, build an explicit relationship funnel instead of an event-attendance checklist. Unless the user specifies a different target, make the Day-90 north star “three compatible active prospects where interest is mutual and both people are genuinely willing to meet again.” Adapt the stages to: compatible people encountered -> contact or match established -> first meeting/date -> mutual interest confirmed -> repeat meeting/date -> active reciprocal prospects. A person becomes an active prospect only through observable reciprocity: both initiate or respond, both accept or propose plans, and both show curiosity and consistency. Do not count one-sided pursuit, ambiguous politeness or merely attending an event as success. Weekly action_outcomes should name a stage conversion, for example “Move two mutual-interest connections into scheduled second dates,” while the Action items may include attending a recurring activity, starting a more personal conversation, making a clear invitation or following up. Never promise that another person will reciprocate; if a conversion does not happen, review channel quality, fit, signal clarity and follow-up rather than blaming the user.

For friendship or social-circle goals, use the analogous funnel: relevant people encountered -> contact exchanged -> one-on-one follow-up -> repeat contact -> reciprocal connection -> reliable social circle. The Day-90 milestone should count reciprocal relationships, not events attended. For health, business and other domains, create equally concrete but safe domain-appropriate action and outcome funnels. Never prescribe medical treatment or unsafe behavior.

Use gentle, believable language. Do not use fear, shame, coercion, cult tactics, “brainwashing,” or invented neuroscience as persuasion. Never claim these exercises rewire the brain, cure a condition, manifest external events, or guarantee success. Encourage professional help when a response suggests trauma, severe distress or a clinical condition.

The funnel object is the strategic source for the real-world action track. Its stages should be practical, personalized and consistent with the weekly tasks. The visible weeks and lucky_method are the primary product.

Assign the most relevant existing Lucky Exercise to every week and choose 3 overall exercises. The identity framework has seven themes; the exercise library may still map the derived seventh step to the closest existing rehearsal practice:
${partList}

Respond with a single JSON object matching the required schema exactly. Do not include any text outside the JSON.`;
}

function buildUserPrompt({ goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, gap, intensity, category, category_key }) {
  const choiceList = value => Array.isArray(value) && value.length ? value.join(', ') : '(not specified)';
  return `Goal category: ${category || '(not specified)'} (${category_key || 'general'} decision path)
Current baseline: ${baseline || '(not specified)'}
Current stage: ${current_stage || '(not specified)'}
Role-transition evidence for gap diagnosis: ${gap || '(not specified)'}

LUCKY STEP 1 — CLARIFY WHAT THEY TRULY WANT
Measurable 90-day outcome: ${goal}
Type of success evidence: ${outcome_type || '(not specified)'}
Why it matters now: ${why || '(not specified)'}

LUCKY STEP 2 — VISUALIZE THE LIVED PROCESS
Behaviors they selected: ${choiceList(process_types)}
Their description of a realistic week: ${process_vision || '(not specified)'}

LUCKY STEP 3 — REFRAME A LIMITING BELIEF
Belief pattern they selected: ${limiting_belief_type || '(not specified)'}
The thought and behavior it triggers: ${limiting_belief || '(not specified)'}
Evidence/resource types: ${choiceList(resource_types)}
Evidence and resources already available: ${resources || '(none specified)'}
Believable replacement thought they will test: ${reframe || '(not specified)'}

LUCKY STEP 4 — ASK THEIR FUTURE SELF
Repeated choices they selected: ${choiceList(future_choices)}
Advice from their Day-90 self: ${future_self || '(not specified)'}

LUCKY STEP 5 — TAKE REAL-WORLD ACTION
High-leverage action types: ${choiceList(action_types)}
Hours per week they can commit: ${hours || 'unspecified'} (${intensity} intensity)
Realistic days or time blocks: ${schedule || '(not specified)'}
Week 1 begins: ${start_date || '(not specified)'}
Constraints the plan must protect: ${constraints || '(none specified)'}
Type of first-week win they selected: ${first_week_type || '(not specified)'}
What would make the first seven days successful: ${first_week || '(not specified)'}

LUCKY STEP 6 — COMMIT TO THE GOAL, RELEASE THE ROUTE
Feedback signals they selected: ${choiceList(obstacle_types)}
Warning sign that should trigger adjustment: ${obstacle || '(not specified)'}
Evidence review cadence: ${review_cadence || 'Weekly'}

Build their 90-day action-and-mindset journey now. First infer and clearly articulate the gap between their current identity and desired identity using the specific roles, operating modes, strengths and tensions in their answers. Use the external goal to create concrete weekly actions and use the identity framework to help the person execute those actions consistently. Follow the seven-step mindset sequence exactly: Week 1 Target Acquisition, Week 2 Threat Modeling, Week 3 Identity Engineering, Week 4 Environmental Sabotage, Week 5 FATE, Week 6 FEAR, Week 7 Identity Integration, then Weeks 8-12 deepen and consolidate the sequence as specified. Every week needs 3 measurable Action items, 1 directly supportive Mindset item, and an identity-evidence question. Week 12 must end with a first-person identity declaration, a continuation ritual and a concrete next-90-day action.`;
}

function normalizeIdentityPlan(plan) {
  if (!plan || !Array.isArray(plan.weeks)) return plan;
  const sequence = [
    [1, 'Target Acquisition'], [2, 'Threat Modeling'], [3, 'Identity Engineering'], [4, 'Environmental Sabotage'],
    [5, 'Mammalian Brain Reprogramming (FATE)'], [6, 'FEAR Protocol'], [7, 'Identity Integration'],
    [1, 'Target Acquisition · Refine'], [2, 'Threat Modeling · Update'], [3, 'Identity Engineering · Deepen'],
    [5, 'Environmental Cues + FATE · Strengthen'], [7, 'FEAR + Identity Integration · Continue'],
  ];
  const cleanPrefix = value => String(value || '').replace(/^(?:action|mindset)\s*:\s*/i, '').trim();
  return {
    ...plan,
    plan_mode: 'action_mindset',
    weeks: plan.weeks.slice(0, 12).map((week, index) => {
      const rawActions = Array.isArray(week.actions) ? week.actions.slice(0, 4) : [];
      const actionItems = rawActions.slice(0, 3).map(item => `Action: ${cleanPrefix(item)}`);
      while (actionItems.length < 3) actionItems.push(`Action: Complete one measurable step toward ${week.action_outcome || week.target || 'this week’s outcome'}.`);
      const mindsetItem = `Mindset: ${cleanPrefix(rawActions[3] || `Practice this shift: ${week.mindset_shift || 'respond as the person you are becoming'}.`)}`;
      return {
        ...week,
        week: index + 1,
        framework_step: sequence[index]?.[0] || week.framework_step,
        theme: sequence[index]?.[1] || week.theme,
        action_outcome: week.action_outcome || week.target || 'Produce one observable result this week.',
        mindset_shift: week.mindset_shift || 'From waiting to feel ready to acting and learning from evidence.',
        identity_evidence: week.identity_evidence || 'What did you do this week that the person you are becoming would naturally do?',
        actions: [...actionItems, mindsetItem],
      };
    }),
  };
}

async function callGeminiOnce(goalData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI planning is not configured');
    err.status = 500;
    throw err;
  }

  const geminiStart = Date.now();
  const res = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(goalData) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: PLAN_SCHEMA,
        maxOutputTokens: 10000,
      },
    }),
  });
  console.log(`Gemini responded in ${Date.now() - geminiStart}ms with status ${res.status}`);

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Gemini ${res.status}: ${detail}`);
    const err = new Error('The AI planner is temporarily unavailable');
    err.status = 502;
    err.upstreamStatus = res.status;
    // Free-tier quota errors come in two shapes with very different real
    // wait times: per-minute (clears in seconds) vs per-day (a fixed daily
    // request cap, already exhausted — doesn't clear until Google's daily
    // reset, not "in a minute"). Telling a user to retry shortly when the
    // real constraint is a day-long cap is actively misleading.
    err.isDailyQuota = res.status === 429 && detail.includes('PerDay');
    throw err;
  }

  const data = await res.json();

  if (data.promptFeedback?.blockReason) {
    const err = new Error('The AI planner declined to generate this plan');
    err.status = 502;
    throw err;
  }

  const candidate = data.candidates?.[0];
  if (!candidate || candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
    const err = new Error('The AI planner declined to generate this plan');
    err.status = 502;
    throw err;
  }

  const text = candidate.content?.parts?.[0]?.text;
  if (!text) {
    const err = new Error('The AI planner returned an unexpected response');
    err.status = 502;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('The AI planner returned invalid JSON');
    err.status = 502;
    throw err;
  }
}

// 429 (quota exhausted) isn't worth retrying inline — Google's own suggested
// retry delays run tens of seconds, far past what's reasonable to hold a
// user's request open for. Fail fast with a distinct message instead.
// 500/502/503/504 (transient overload) genuinely do clear on a retry, but
// live production traffic has shown this isn't a rare blip — both attempts
// in a fixed 3-try budget failed back to back more than once, each attempt
// alone taking anywhere from 2-19s. Rather than guess a fixed attempt count,
// keep retrying for as long as time budget actually allows: observed total
// request times (~22s) leave plenty of the 60s maxDuration unused.
const OVERLOAD_STATUSES = new Set([500, 502, 503, 504]);
const OVERLOAD_BACKOFFS_MS = [750, 1500, 2500, 4000];
// Must cover the worst-case duration of the NEXT attempt itself, not just
// other handler overhead — live logs showed a single Gemini call taking
// 26.4s, and an 8s margin let the retry loop start one more attempt than
// it had time for, resulting in "Vercel Runtime Timeout Error: Task timed
// out after 60 seconds" mid-retry. That's strictly worse than giving up
// early: a hard kill sends the client no response at all (not even an
// error), leaving them stuck on the generating screen indefinitely,
// whereas giving up in time still returns a clean, visible error.
const GEMINI_DEADLINE_SAFETY_MS = 30_000;

async function callGemini(goalData, deadlineAt) {
  let lastErr;
  for (let attempt = 1; ; attempt++) {
    try {
      return await callGeminiOnce(goalData);
    } catch (err) {
      lastErr = err;
      if (err.upstreamStatus === 429) {
        err.message = err.isDailyQuota
          ? "The AI planner has hit its daily limit — it won't be available again until that resets. Please try again later."
          : 'The AI planner is rate-limited right now — please try again in a minute';
        throw err;
      }
      if (!OVERLOAD_STATUSES.has(err.upstreamStatus)) throw err;
      const backoff = OVERLOAD_BACKOFFS_MS[Math.min(attempt - 1, OVERLOAD_BACKOFFS_MS.length - 1)];
      if (Date.now() + backoff + GEMINI_DEADLINE_SAFETY_MS >= deadlineAt) {
        console.log(`Gemini attempt ${attempt} failed with ${err.upstreamStatus}, out of time budget — giving up`);
        throw err;
      }
      console.log(`Gemini attempt ${attempt} failed with ${err.upstreamStatus}, retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function careerDialogueCoach({ question, answer, nextQuestion, context = [] }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AI onboarding is not configured'), { status: 500 });
  const transcript = context.slice(-4).map(item => `Q: ${String(item.question || '').slice(0, 300)}\nA: ${String(item.answer || '').slice(0, 600)}`).join('\n');
  const prompt = `You are Lucky, a warm and concise job-search coach conducting a short onboarding conversation.
Previous context:
${transcript || '(first answer)'}
Current question: ${String(question || '').slice(0, 400)}
User answer: ${String(answer || '').slice(0, 900)}
Next question: ${String(nextQuestion || '').slice(0, 400)}

Respond with one natural sentence, at most 22 words. Acknowledge one useful detail from the answer. Do not introduce, foreshadow, or repeat the next question. Do not give a plan yet, praise generically, or repeat the answer verbatim.`;
  const response = await fetch(GEMINI_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 80, temperature: 0.55 } }) });
  if (!response.ok) throw Object.assign(new Error('AI onboarding is temporarily unavailable'), { status: 502 });
  const data = await response.json(); const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw Object.assign(new Error('AI onboarding returned an empty response'), { status: 502 });
  return reply.replace(/^['"]|['"]$/g, '');
}

export default async function handler(req, res) {
  const requestStart = Date.now();
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Same-origin GET requests commonly omit Origin. In that case, reconstruct
  // the request origin from Vercel's trusted forwarded host/protocol headers.
  const origin = getRequestOrigin(req);
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden' });

  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitMap.get(ip) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_MAX) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests' });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Goal planning is not configured' });
  }

  const user = await getUserFromToken(req.headers.authorization, serviceRoleKey);
  if (!user) {
    return res.status(401).json({ error: 'Sign in required' });
  }

  if (req.method === 'GET') {
    const usage = await claimGeneration(user.id, user.email, serviceRoleKey);
    if (!usage) return res.status(500).json({ error: 'Could not read plan allowance' });
    if (req.query?.mode === 'questions') {
      if (!usage.goalData?._beta_access) return res.status(403).json({ error: 'A valid invitation code is required before starting onboarding.', code: 'INVITATION_REQUIRED' });
      return res.status(200).json({ tree: getOnboardingTree(req.query?.category) });
    }
    return res.status(200).json({ usage: { used: usage.used, remaining: usage.remaining, limit: usage.unlimited ? null : PLAN_GENERATION_LIMIT, unlimited: usage.unlimited } });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (body?.action === 'career_dialogue') {
    const usage = await claimGeneration(user.id, user.email, serviceRoleKey);
    if (!usage?.goalData?._beta_access) return res.status(403).json({ error: 'A valid invitation code is required before starting onboarding.', code: 'INVITATION_REQUIRED' });
    if (!String(body.answer || '').trim()) return res.status(400).json({ error: 'Add a short answer before continuing.' });
    try { return res.status(200).json({ reply: await careerDialogueCoach({ question: body.question, answer: body.answer, nextQuestion: body.next_question, context: Array.isArray(body.context) ? body.context : [] }) }); }
    catch (error) { return res.status(error.status || 500).json({ error: error.message || 'Could not continue onboarding.' }); }
  }

  if (body?.action === 'adjust_week') {
    try { return res.status(200).json(await adjustNextWeek(user, body, serviceRoleKey)); }
    catch (error) {
      console.error(`adjust-week failed for ${user.id}: ${error.message}`);
      return res.status(error.status || 500).json({ error: error.message || 'Could not adjust next week' });
    }
  }

  const { goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, gap, category, category_key } = body ?? {};
  if (!goal?.trim()) return res.status(400).json({ error: 'Goal is required' });

  const hoursNum = { '1-2': 2, '3-5': 4, '5-10': 7, '10+': 12 }[hours] || 5;
  const intensity = hoursNum <= 2 ? 'light' : hoursNum <= 5 ? 'moderate' : 'intensive';

  const deadlineAt = requestStart + config.maxDuration * 1000;

  const claimed = await claimGeneration(user.id, user.email, serviceRoleKey);
  if (!claimed) return res.status(500).json({ error: 'Could not prepare plan generation' });
  if (!claimed.goalData?._beta_access) return res.status(403).json({ error: 'A valid invitation code is required before generating a plan.', code: 'INVITATION_REQUIRED' });
  if (!claimed.allowed) return res.status(403).json({ error: 'You have used all three Master Plan generations for this account.', code: 'PLAN_LIMIT_REACHED', usage: { used: claimed.used, remaining: 0, limit: PLAN_GENERATION_LIMIT } });

  try {
    const generationAnswers = { goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, gap, intensity, category, category_key };
    const plan = normalizeIdentityPlan(await callGemini(generationAnswers, deadlineAt));
    console.log(`decompose-goal succeeded in ${Date.now() - requestStart}ms for user ${user.id}`);
    const generationCount = claimed.used + 1;
    const saved = await saveGenerationResult(user.id, body, { ...plan, intensity }, generationCount, serviceRoleKey, claimed.goalData);
    if (!saved) { const saveError = new Error('Your plan was created but could not be saved. Please try again.'); saveError.status = 500; throw saveError; }
    const fullPlan = { ...plan, intensity };
    const access = await getPlanAccess(user.id, serviceRoleKey);
    return res.status(200).json({ plan: access.unlocked ? fullPlan : createPlanPreview(fullPlan), access, usage: { used: generationCount, remaining: claimed.unlimited ? null : Math.max(0, PLAN_GENERATION_LIMIT - generationCount), limit: claimed.unlimited ? null : PLAN_GENERATION_LIMIT, unlimited: claimed.unlimited } });
  } catch (err) {
    const status = err.status || 500;
    console.error(`decompose-goal failed in ${Date.now() - requestStart}ms for user ${user.id}: ${err.message}`);
    return res.status(status).json({ error: err.message || 'Failed to generate plan' });
  }
}
