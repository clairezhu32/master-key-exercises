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
const RATE_MAX = 10;

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

// The six Lucky Method themes are embedded in the prompt so weekly exercise
// recommendations stay aligned with the product's vision-to-action framework.
const PART_THEMES = [
  'Clarify What You Truly Want',
  'Visualize the Lived Process',
  'Reframe a Limiting Belief',
  'Ask Your Future Self',
  'Take One Real-World Action',
  'Commit to the Goal, Release the Route',
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
  return { used, remaining: Math.max(0, PLAN_GENERATION_LIMIT - used), allowed: used < PLAN_GENERATION_LIMIT, goalData: record?.goal_data || {} };
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
    domain_label: { type: 'STRING', description: "Short label for the goal domain, e.g. 'Career / Job Search', 'Business Launch', 'Marathon Training'." },
    summary: { type: 'STRING', description: "1-2 sentences tying the plan to the person's stated reason for pursuing it." },
    insight: { type: 'STRING', description: 'One sharp, non-obvious strategic insight specific to this goal and this obstacle — not generic motivational text.' },
    milestone_90day: { type: 'STRING', description: 'The single concrete, measurable outcome that defines success at day 90.' },
    lucky_method: {
      type: 'ARRAY',
      description: 'Exactly 6 personalized guidance steps, in the canonical Lucky Method order. Each step must connect directly to this person’s goal, obstacle and plan—not repeat generic manifestation language.',
      items: {
        type: 'OBJECT',
        properties: {
          step: { type: 'INTEGER', description: '1 through 6.' },
          title: { type: 'STRING', description: 'Use the exact canonical Lucky Method title for this step.' },
          guidance: { type: 'STRING', description: 'One concise, personalized explanation of how this step applies to the person’s goal and current situation.' },
          action: { type: 'STRING', description: 'One concrete, observable action or reflection prompt the person can complete.' },
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
            description: { type: 'STRING' },
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
            description: { type: 'STRING' },
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
      description: 'Exactly 12 weeks — a full execution cadence. Front-load early weeks on targets/access/outreach and later weeks on prep/close, matching how this specific goal actually plays out over 90 days. For career plans, keep networking, resume/application execution, and interview preparation running in parallel every week rather than assigning them to isolated phases.',
      items: {
        type: 'OBJECT',
        properties: {
          week: { type: 'INTEGER', description: '1 through 12.' },
          funnel_stage: { type: 'STRING', enum: FUNNEL_STAGE_KEYS, description: 'Which funnel stage this week is primarily advancing.' },
          theme: { type: 'STRING' },
          target: { type: 'STRING', description: 'The concrete outcome to hit by the end of this specific week.' },
          actions: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Exactly 3 concrete, doable-today actions for this week.',
          },
          exercise_part: { type: 'INTEGER', description: 'The most relevant Lucky Method exercise step for this specific week, from 1 through 6.' },
          exercise_reason: { type: 'STRING', description: 'One concise sentence connecting this exercise to the week’s target, actions, or likely execution obstacle.' },
        },
        required: ['week', 'funnel_stage', 'theme', 'target', 'actions', 'exercise_part', 'exercise_reason'],
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
  required: ['domain_label', 'summary', 'insight', 'milestone_90day', 'lucky_method', 'funnel', 'weeks', 'exercises'],
};

const ADJUSTED_WEEK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    week: { type: 'INTEGER' },
    funnel_stage: { type: 'STRING', enum: FUNNEL_STAGE_KEYS },
    theme: { type: 'STRING' },
    target: { type: 'STRING', description: 'A concrete, measurable outcome for this week.' },
    actions: { type: 'ARRAY', description: 'Exactly 3 concrete actions sized to the user’s available time.', items: { type: 'STRING' } },
    exercise_part: { type: 'INTEGER', description: 'A Lucky Method step from 1 through 6.' },
    exercise_reason: { type: 'STRING' },
  },
  required: ['week', 'funnel_stage', 'theme', 'target', 'actions', 'exercise_part', 'exercise_reason'],
};

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
  if (!Array.isArray(week.actions) || week.actions.length !== 3) throw Object.assign(new Error('Lucky returned an incomplete weekly adjustment.'), { status: 502 });
  return { ...week, week: context.nextWeek.week };
}

async function adjustNextWeek(user, body, serviceRoleKey) {
  const currentWeekNumber = Number(body.current_week);
  const feedback = cleanWeeklyFeedback(body.feedback);
  if (!Number.isInteger(currentWeekNumber) || currentWeekNumber < 1 || currentWeekNumber >= 12) throw Object.assign(new Error('Choose a week from 1 through 11.'), { status: 400 });
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
  return `You are a strategic execution coach. You turn a person's goal into a hyper-specific 90-day plan by adapting a proven 7-stage growth-funnel framework to whatever domain the goal is in (career, business, health, financial, creative, learning, relationships, or anything else).

The 7 stages, in order:
1. targets — the specific list of what/who to go after
2. access_points — the specific roles/channels to reach at each target, and how to actually find them
3. outreach — a ready-to-send script plus a follow-up, calibrated to the domain
4. gap_closing — the specific gaps between where they are and what the target expects, each paired with a concrete resource/action
5. core_prep — the make-or-break moment (interview, pitch, audition, negotiation, launch, event) broken into a task checklist
6. funnel_metrics — the conversion funnel for this goal with realistic benchmarks, plus how to review and iterate on the weakest step
7. close — the specific checklist to actually land the outcome

Use the six-step Lucky Method as an equally important decision framework throughout the plan:
1. Clarify What You Truly Want — distinguish the person’s own meaningful desire from comparison, status pressure or avoidance; make the day-90 outcome concrete.
2. Visualize the Lived Process — describe the ordinary behaviors, difficult moments and responses that would make progress real; never rely on outcome-only fantasy.
3. Reframe a Limiting Belief — identify the belief most likely to distort behavior, separate facts from assumptions and turn it into a testable, believable alternative.
4. Ask Your Future Self — translate the desired identity into repeated choices the person can make now, without pretending the outcome is guaranteed.
5. Take One Real-World Action — make every week lead to observable behavior, with a small first action that can begin immediately.
6. Commit to the Goal, Release the Route — use funnel metrics and weekly feedback to adjust tactics, timing or path while protecting the meaningful intention behind the goal.

Return all six in lucky_method, in this exact order, personalized to the person’s answers. The plan must never imply that thoughts control external outcomes. Prefer controllable actions, honest experiments and reality-based feedback.

Ground everything in the person's measurable outcome, baseline, reason, stated gap, previous attempts, resources, constraints, obstacle, schedule, and first-week success test — never output advice generic enough to apply to any goal in the category. Reference their own numbers, assets, and wording wherever possible.

Critical honesty rule: never invent a specific real person's name and present them as a real, currently-employed hiring manager, recruiter, investor, or contact — you have no way to verify that. Instead, describe the role/type of person to reach and a concrete, real method to find an actual one (LinkedIn search patterns, company site, referrals, communities, directories). You may name real, well-known public organizations when genuinely relevant as examples, but do not fabricate private details about them.

The plan also includes a 12-week execution cadence mapped onto the 7 stages (front-loading early stages in early weeks). Assign the most relevant Lucky Method exercise to every week based on that week's actions and likely execution obstacle; repetition is appropriate when a practice should be reinforced. Also choose 3 overall exercises for the plan. The 6 Lucky Method steps are:
${partList}

CAREER-PLAN OPERATING RULES
When the decision path is career, job search, promotion, or career transition, do not create a passive or purely sequential plan where the person spends several weeks polishing materials before networking, applying, or preparing for interviews. Run these three lanes in parallel in every week:
1. Network and follow up — identify real warm or relevant contacts, send personalized outreach, request conversations or referrals appropriately, and follow up. If the person has access to Meta Muse, it may be suggested as an optional assistant to organize a user-approved contact list from the person's own connected accounts, draft messages, track follow-ups, or schedule conversations. Never claim Muse has verified professional data, never invent contacts, and never instruct it to send a message without the person's review and approval. Use LinkedIn, company team pages, alumni networks, former colleagues, professional communities, and direct referrals to verify actual professional contacts.
2. Tailor and submit — select high-fit open roles, revise the master resume for the role's requirements using truthful quantified evidence, complete the application, and log the submission and next follow-up. Do not make “revise resume” an endlessly repeated polishing task; each revision must be tied to one or more actual submissions that week.
3. Prepare for interviews — practice the formats likely for the target role, including concise career stories and role-specific cases or technical questions; record weak points and use feedback to improve the next practice.

For a career plan, the three weekly actions should normally map one-to-one to these three lanes. Each action must include a count, deliverable, scheduled session, or submitted application. Week 1 must produce a usable master resume, a verified target/contact list, real outreach, at least one submitted high-fit application when a suitable opening exists, and an interview-practice baseline. Weeks 2–12 must continue producing external evidence—replies, conversations, referrals, applications, screens, interview scores, later rounds, or offers—and adjust the weakest conversion step every week. Respect the person's stated weekly hours and reduce quantities when needed rather than dropping an entire lane.

Respond with a single JSON object matching the required schema exactly. Do not include any text outside the JSON.`;
}

function buildUserPrompt({ goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, intensity, category, category_key }) {
  const choiceList = value => Array.isArray(value) && value.length ? value.join(', ') : '(not specified)';
  const careerExecution = category_key === 'career' ? `

CAREER EXECUTION REQUIREMENT
Build every week around three parallel actions: (1) verified networking/referral outreach and follow-up, optionally using Meta Muse to organize the person's own contacts and draft user-reviewed messages; (2) truthful role-specific resume tailoring followed by actual application submission and tracking; and (3) scheduled interview preparation with a concrete practice output or score. Use the person's stated target role and companies in every action where relevant. Never substitute tool setup, generic learning, or resume polishing for external job-search activity.` : '';
  return `Goal category: ${category || '(not specified)'} (${category_key || 'general'} decision path)
Current baseline: ${baseline || '(not specified)'}
Current stage: ${current_stage || '(not specified)'}

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

Build their strategic plan now. Treat all six Lucky steps above as core planning inputs, not decorative mindset advice. Week 1 must directly deliver the first-week success test. Later weeks must credibly bridge their baseline to the measurable 90-day outcome, use their chosen real-world actions, test the reframed belief through evidence, and adjust tactics at the stated review cadence without abandoning the meaningful intention.${careerExecution}`;
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
        maxOutputTokens: 8000,
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
    return res.status(200).json({ usage: { used: usage.used, remaining: usage.remaining, limit: PLAN_GENERATION_LIMIT } });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (body?.action === 'adjust_week') {
    try { return res.status(200).json(await adjustNextWeek(user, body, serviceRoleKey)); }
    catch (error) {
      console.error(`adjust-week failed for ${user.id}: ${error.message}`);
      return res.status(error.status || 500).json({ error: error.message || 'Could not adjust next week' });
    }
  }

  const { goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, category, category_key } = body ?? {};
  if (!goal?.trim()) return res.status(400).json({ error: 'Goal is required' });

  const hoursNum = { '1-2': 2, '3-5': 4, '5-10': 7, '10+': 12 }[hours] || 5;
  const intensity = hoursNum <= 2 ? 'light' : hoursNum <= 5 ? 'moderate' : 'intensive';

  const deadlineAt = requestStart + config.maxDuration * 1000;

  const claimed = await claimGeneration(user.id, user.email, serviceRoleKey);
  if (!claimed) return res.status(500).json({ error: 'Could not prepare plan generation' });
  if (!claimed.goalData?._beta_access) return res.status(403).json({ error: 'A valid invitation code is required before generating a plan.', code: 'INVITATION_REQUIRED' });
  if (!claimed.allowed) return res.status(403).json({ error: 'You have used all three Master Plan generations for this account.', code: 'PLAN_LIMIT_REACHED', usage: { used: claimed.used, remaining: 0, limit: PLAN_GENERATION_LIMIT } });

  try {
    const plan = await callGemini({ goal, outcome_type, baseline, current_stage, why, process_vision, process_types, limiting_belief, limiting_belief_type, resources, resource_types, reframe, future_self, future_choices, action_types, constraints, obstacle, obstacle_types, review_cadence, hours, schedule, start_date, first_week, first_week_type, intensity, category, category_key }, deadlineAt);
    console.log(`decompose-goal succeeded in ${Date.now() - requestStart}ms for user ${user.id}`);
    const generationCount = claimed.used + 1;
    const saved = await saveGenerationResult(user.id, body, { ...plan, intensity }, generationCount, serviceRoleKey, claimed.goalData);
    if (!saved) { const saveError = new Error('Your plan was created but could not be saved. Please try again.'); saveError.status = 500; throw saveError; }
    const fullPlan = { ...plan, intensity };
    const access = await getPlanAccess(user.id, serviceRoleKey);
    return res.status(200).json({ plan: access.unlocked ? fullPlan : createPlanPreview(fullPlan), access, usage: { used: generationCount, remaining: PLAN_GENERATION_LIMIT - generationCount, limit: PLAN_GENERATION_LIMIT } });
  } catch (err) {
    const status = err.status || 500;
    console.error(`decompose-goal failed in ${Date.now() - requestStart}ms for user ${user.id}: ${err.message}`);
    return res.status(status).json({ error: err.message || 'Failed to generate plan' });
  }
}
