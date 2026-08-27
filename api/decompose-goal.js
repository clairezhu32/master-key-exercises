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

// Part themes are embedded in the prompt so the model grounds its exercise
// picks in the real course instead of guessing at what each part covers.
const PART_THEMES = [
  'Physical Stillness', 'Mental Quiet', 'Complete Relaxation', "The True 'I'",
  'The Mental Home', 'Concentration on Harmony', 'Visualization', 'The Core Affirmation',
  'The Greatest Good', 'The Law of Abundance', 'Universal Connection', 'The Creative Power',
  'Oneness', 'Inner Radiance', 'The Law of Growth', 'The Power of Insight',
  'The Law of Vibration', 'The Power of Attention', 'Truth', 'Inspiration',
  'Money Consciousness', 'Perfect Health', 'The Large Idea', 'The Master Key',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/master-key-exercises[^.]*\.vercel\.app$/.test(origin)) return true;
  const custom = process.env.ALLOWED_ORIGIN;
  if (custom && origin === custom) return true;
  return false;
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

// One goal per account, permanently — no regenerating with a second goal
// once a plan has successfully been generated. "Already has a goal" is
// defined by having actual recoverable plan content, not just a row: rows
// created before server-side plan persistence was added (or from any
// generation that was claimed but never completed) have no plan/goal_data,
// and blocking those accounts forever with nothing to show for it is a
// dead end — the account is stuck unable to generate and unable to see any
// plan. Treat a contentless row as reclaimable rather than a real claim.
async function claimGeneration(userId, email, serviceRoleKey) {
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}&select=plan`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
  );
  if (existing.ok) {
    const rows = await existing.json();
    if (rows[0]?.plan) return false; // genuinely already has a plan
  }
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
  return res.ok;
}

// mks_goal_generations is also the durable copy of the plan itself:
// generation can take 40-50s+ under sustained Gemini overload, and a
// client-side page reload/navigation mid-request could otherwise silently
// lose a plan that had actually succeeded, since it previously only ever
// lived in the browser's localStorage. Write failures are logged but
// non-fatal to the response — shouldn't fail an otherwise-successful
// generation the user is waiting on.
async function saveGenerationResult(userId, goalData, plan, serviceRoleKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ goal_data: goalData, plan, generated_at: new Date().toISOString() }),
  });
  if (!res.ok) console.error(`Failed to save generation result for user ${userId}: ${res.status}`);
}

// Best-effort: give back the one allowed goal if the Gemini call that was
// supposed to use it failed, so a transient AI-provider error doesn't
// permanently lock someone out before they've ever gotten a plan.
async function releaseGeneration(userId, serviceRoleKey) {
  await fetch(`${SUPABASE_URL}/rest/v1/mks_goal_generations?user_id=eq.${userId}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  }).catch(() => {});
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
    funnel: {
      type: 'OBJECT',
      description: 'A 7-stage execution journey adapted to this goal domain. Use a literal opportunity funnel for external goals and a behavior-change pathway for internal goals.',
      properties: {
        targets: {
          type: 'OBJECT',
          properties: {
            description: { type: 'STRING', description: 'What "targets" means for this specific goal and how to build the list.' },
            items: {
              type: 'ARRAY',
              description: 'Provide 3 to 10 specific external targets, target behaviors, or measurable outcome components—whichever fits this domain.',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'A specific target, behavior, milestone component, or well-defined target archetype—never a fabricated entity presented as real.' },
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
                  role_to_reach: { type: 'STRING', description: "For external goals, the person or channel to reach. For internal goals, the support person, environmental trigger, tool, place, or routine entry point to use." },
                  how_to_find_them: { type: 'STRING', description: 'A concrete method to identify, create, schedule, or activate this access point.' },
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
            first_message_script: { type: 'STRING', description: 'For external goals, a ready-to-send message. For internal goals, a short accountability request, implementation intention, or self-instruction to begin the behavior.' },
            follow_up_script: { type: 'STRING', description: 'For external goals, a follow-up message. For internal goals, a recovery script for returning after a missed action.' },
            cadence: { type: 'STRING', description: 'The realistic communication, practice, accountability, or recovery cadence.' },
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
            description: { type: 'STRING', description: "The core performance moment or repeatable routine that most directly produces this goal, and how preparation breaks down." },
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
              description: 'The ordered leading indicators for this goal. Use conversion steps for external goals or behavior/outcome measures for internal goals. Provide 3 to 6 steps.',
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
      description: 'Exactly 12 weeks forming a credible bridge from the stated baseline to the measurable outcome. Week 1 must deliver the user-defined first-week success test; later weeks should follow the category-appropriate execution journey.',
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
        },
        required: ['week', 'funnel_stage', 'theme', 'target', 'actions'],
      },
    },
    exercises: {
      type: 'ARRAY',
      description: 'Exactly 3 exercises.',
      items: {
        type: 'OBJECT',
        properties: {
          part: { type: 'INTEGER', description: '1 through 24, matching the course part number.' },
          reason: { type: 'STRING', description: "Why this specific part's theme addresses this person's stated obstacle." },
        },
        required: ['part', 'reason'],
      },
    },
  },
  required: ['domain_label', 'summary', 'insight', 'milestone_90day', 'funnel', 'weeks', 'exercises'],
};

function buildSystemPrompt() {
  const partList = PART_THEMES.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `You are a strategic execution coach. You turn a person's measurable goal into a hyper-specific 90-day plan grounded in their current baseline, previous attempts, available resources, real schedule, obstacle, and desired first-week proof of momentum.

Adapt the planning logic to the goal category. For business, career, audience, or acquisition goals, use the stages as a literal opportunity and conversion funnel. For health, relationships, learning, creative practice, or inner-peace goals, translate them into a behavior-change journey: the right target behavior, environmental access points and triggers, support or accountability, gaps to close, core routines, leading measures, and a sustainable finish. Never prescribe cold outreach, conversion tactics, or business language when it does not fit the person's domain.

The 7 stages, in order:
1. targets — the specific list of what/who to go after
2. access_points — the specific roles/channels to reach at each target, and how to actually find them
3. outreach — a ready-to-send script plus a follow-up, calibrated to the domain
4. gap_closing — the specific gaps between where they are and what the target expects, each paired with a concrete resource/action
5. core_prep — the make-or-break moment (interview, pitch, audition, negotiation, launch, event) broken into a task checklist
6. funnel_metrics — the conversion funnel for this goal with realistic benchmarks, plus how to review and iterate on the weakest step
7. close — the specific checklist to actually land the outcome

Ground everything in the person's stated outcome, baseline, reason, previous attempts, resources, obstacle, availability, and first-week success test — never output advice generic enough to apply to any goal in the category. Use their current numbers and assets when setting weekly milestones. Do not recommend an approach they already tried unsuccessfully unless you explicitly change the method based on what they learned.

Critical honesty rule: never invent a specific real person's name and present them as a real, currently-employed hiring manager, recruiter, investor, or contact — you have no way to verify that. Instead, describe the role/type of person to reach and a concrete, real method to find an actual one (LinkedIn search patterns, company site, referrals, communities, directories). You may name real, well-known public organizations when genuinely relevant as examples, but do not fabricate private details about them.

The plan also includes a 12-week execution cadence mapped onto the 7 stages (front-loading early stages in early weeks), and 3 Master Key System exercises chosen for genuine relevance to the person's stated obstacle. The 24 parts of the course are:
${partList}

Respond with a single JSON object matching the required schema exactly. Do not include any text outside the JSON.`;
}

function buildUserPrompt({ goal, baseline, why, tried, resources, obstacle, hours, schedule, first_week, intensity, category }) {
  return `Goal category: ${category || '(not specified)'}
Measurable 90-day outcome: ${goal}
Current baseline: ${baseline || '(not specified)'}
Why it matters to them: ${why || '(not specified)'}
What they already tried and what happened: ${tried || '(nothing specified)'}
Resources and advantages already available: ${resources || '(none specified)'}
Their biggest obstacle right now: ${obstacle || '(not specified)'}
Hours per week they can commit: ${hours || 'unspecified'} (${intensity} intensity)
Realistic days or time blocks: ${schedule || '(not specified)'}
What would make the first seven days successful: ${first_week || '(not specified)'}

Build their category-appropriate strategic plan now. Make week 1 directly deliver the first-week success test, and make every later week credibly bridge the stated baseline to the measurable 90-day outcome within the available time.`;
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || '';
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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { goal, baseline, why, tried, resources, obstacle, hours, schedule, first_week, category } = body ?? {};
  if (!goal?.trim()) return res.status(400).json({ error: 'Goal is required' });

  const hoursNum = { '1-2': 2, '3-5': 4, '5-10': 7, '10+': 12 }[hours] || 5;
  const intensity = hoursNum <= 2 ? 'light' : hoursNum <= 5 ? 'moderate' : 'intensive';

  const deadlineAt = requestStart + config.maxDuration * 1000;

  const claimed = await claimGeneration(user.id, user.email, serviceRoleKey);
  if (!claimed) {
    return res.status(403).json({ error: 'This account already has a goal — only one goal is allowed per account' });
  }

  try {
    const plan = await callGemini({ goal, baseline, why, tried, resources, obstacle, hours, schedule, first_week, intensity, category }, deadlineAt);
    console.log(`decompose-goal succeeded in ${Date.now() - requestStart}ms for user ${user.id}`);
    await saveGenerationResult(user.id, body, { ...plan, intensity }, serviceRoleKey);
    return res.status(200).json({ plan: { ...plan, intensity } });
  } catch (err) {
    await releaseGeneration(user.id, serviceRoleKey);
    const status = err.status || 500;
    console.error(`decompose-goal failed in ${Date.now() - requestStart}ms for user ${user.id}: ${err.message}`);
    return res.status(status).json({ error: err.message || 'Failed to generate plan' });
  }
}
