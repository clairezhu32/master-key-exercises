const rateLimitMap = new Map();
const RATE_WINDOW_MS = 3_600_000;
const RATE_MAX = 10;

// gpt-4o is the safe, well-established default for Structured Outputs (json_schema
// strict mode). Override via env var for a different model — note that o-series
// reasoning models require `max_completion_tokens` instead of `max_tokens` below.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

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

const FUNNEL_STAGE_KEYS = ['targets', 'access_points', 'outreach', 'gap_closing', 'core_prep', 'funnel_metrics', 'close'];

// OpenAI's strict Structured Outputs mode requires every object node to set
// additionalProperties: false and list every property as required, and does not
// support minItems/maxItems — those count expectations live in the prompt instead.
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain_label: { type: 'string', description: "Short label for the goal domain, e.g. 'Career / Job Search', 'Business Launch', 'Marathon Training'." },
    summary: { type: 'string', description: "1-2 sentences tying the plan to the person's stated reason for pursuing it." },
    insight: { type: 'string', description: 'One sharp, non-obvious strategic insight specific to this goal and this obstacle — not generic motivational text.' },
    milestone_90day: { type: 'string', description: 'The single concrete, measurable outcome that defines success at day 90.' },
    funnel: {
      type: 'object',
      additionalProperties: false,
      description: 'A 7-stage strategic funnel adapted to this specific goal domain, modeled on: targets -> access points -> outreach -> gap-closing -> core preparation -> funnel metrics/iteration -> close.',
      properties: {
        targets: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', description: 'What "targets" means for this specific goal and how to build the list.' },
            items: {
              type: 'array',
              description: 'Provide 5 to 12 specific targets.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', description: 'A specific target or a specific, well-defined target archetype (e.g. a real well-known company/organization if genuinely relevant, or a precise criteria-based category — never a fabricated specific entity presented as real).' },
                  why_it_fits: { type: 'string' },
                },
                required: ['name', 'why_it_fits'],
              },
            },
          },
          required: ['description', 'items'],
        },
        access_points: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            items: {
              type: 'array',
              description: 'Provide 3 to 10 access points.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  role_to_reach: { type: 'string', description: "The type of person/channel to reach, e.g. 'Hiring manager for the team', 'Recruiter for the function', never a fabricated named individual." },
                  how_to_find_them: { type: 'string', description: 'A concrete, actionable method to identify a real person or channel in this role.' },
                },
                required: ['role_to_reach', 'how_to_find_them'],
              },
            },
          },
          required: ['description', 'items'],
        },
        outreach: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            first_message_script: { type: 'string', description: 'A ready-to-send outreach message template, personalized with [bracketed placeholders] for the person to fill in.' },
            follow_up_script: { type: 'string', description: 'A ready-to-send follow-up template for no response.' },
            cadence: { type: 'string', description: 'How often and in what pattern to send outreach and follow-ups.' },
          },
          required: ['description', 'first_message_script', 'follow_up_script', 'cadence'],
        },
        gap_closing: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            gaps: {
              type: 'array',
              description: 'Provide 3 to 6 gaps.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  gap: { type: 'string', description: 'A specific gap between where they are now and what the target expects, inferred from their stated goal/obstacle.' },
                  why_it_matters: { type: 'string' },
                  resource: { type: 'string', description: 'A specific type of resource to close it (course, template, book, tool, practice method) — describe it concretely even if you cannot verify a live link.' },
                  action: { type: 'string', description: 'The concrete next action to close this gap.' },
                },
                required: ['gap', 'why_it_matters', 'resource', 'action'],
              },
            },
          },
          required: ['description', 'gaps'],
        },
        core_prep: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', description: "What the 'make-or-break moment' is for this goal (interview, pitch, audition, negotiation, launch, race day, etc.) and how prep breaks down." },
            tasks: {
              type: 'array',
              description: 'Provide 4 to 8 tasks.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { task: { type: 'string' }, detail: { type: 'string' } },
                required: ['task', 'detail'],
              },
            },
          },
          required: ['description', 'tasks'],
        },
        funnel_metrics: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            steps: {
              type: 'array',
              description: 'The ordered conversion funnel for this goal, e.g. outreach sent -> replies -> meetings -> next-round -> close. Provide 3 to 6 steps.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  step_name: { type: 'string' },
                  benchmark: { type: 'string', description: 'A realistic target count or conversion rate for this step, stated as a number/range.' },
                },
                required: ['step_name', 'benchmark'],
              },
            },
            iteration_plan: { type: 'string', description: 'How and how often to review the funnel numbers and what to change at the weakest step.' },
          },
          required: ['description', 'steps', 'iteration_plan'],
        },
        close: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            checklist: {
              type: 'array',
              description: 'Provide 4 to 8 checklist items.',
              items: { type: 'string' },
            },
          },
          required: ['description', 'checklist'],
        },
      },
      required: FUNNEL_STAGE_KEYS,
    },
    weeks: {
      type: 'array',
      description: 'Exactly 12 weeks — a full execution cadence. Front-load early weeks on targets/access/outreach and later weeks on prep/close, matching how this specific goal actually plays out over 90 days.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          week: { type: 'integer', description: '1 through 12.' },
          funnel_stage: { type: 'string', enum: FUNNEL_STAGE_KEYS, description: 'Which funnel stage this week is primarily advancing.' },
          theme: { type: 'string' },
          target: { type: 'string', description: 'The concrete outcome to hit by the end of this specific week.' },
          actions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exactly 3 concrete, doable-today actions for this week.',
          },
        },
        required: ['week', 'funnel_stage', 'theme', 'target', 'actions'],
      },
    },
    exercises: {
      type: 'array',
      description: 'Exactly 3 exercises.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          part: { type: 'integer', description: '1 through 24, matching the course part number.' },
          reason: { type: 'string', description: "Why this specific part's theme addresses this person's stated obstacle." },
        },
        required: ['part', 'reason'],
      },
    },
  },
  required: ['domain_label', 'summary', 'insight', 'milestone_90day', 'funnel', 'weeks', 'exercises'],
};

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

Ground everything in the person's actual stated goal, reason, 90-day vision, and obstacle — never output advice generic enough to apply to any goal in the category. Reference specifics from their own wording wherever possible.

Critical honesty rule: never invent a specific real person's name and present them as a real, currently-employed hiring manager, recruiter, investor, or contact — you have no way to verify that. Instead, describe the role/type of person to reach and a concrete, real method to find an actual one (LinkedIn search patterns, company site, referrals, communities, directories). You may name real, well-known public organizations when genuinely relevant as examples, but do not fabricate private details about them.

The plan also includes a 12-week execution cadence mapped onto the 7 stages (front-loading early stages in early weeks), and 3 Master Key System exercises chosen for genuine relevance to the person's stated obstacle. The 24 parts of the course are:
${partList}

Respond with a single JSON object matching the required schema exactly. Do not include any text outside the JSON.`;
}

function buildUserPrompt({ goal, why, vision, obstacle, hours, intensity }) {
  return `Goal: ${goal}
Why it matters to them: ${why || '(not specified)'}
What meaningful progress looks like in 90 days: ${vision || '(not specified)'}
Their biggest obstacle right now: ${obstacle || '(not specified)'}
Hours per week they can commit: ${hours || 'unspecified'} (${intensity} intensity)

Build their strategic funnel plan now.`;
}

async function callOpenAI(goalData) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI planning is not configured');
    err.status = 500;
    throw err;
  }

  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(goalData) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'strategic_plan', strict: true, schema: PLAN_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`OpenAI ${res.status}: ${detail}`);
    const err = new Error('The AI planner is temporarily unavailable');
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (message?.refusal) {
    const err = new Error('The AI planner declined to generate this plan');
    err.status = 502;
    throw err;
  }
  if (!message?.content) {
    const err = new Error('The AI planner returned an unexpected response');
    err.status = 502;
    throw err;
  }

  try {
    return JSON.parse(message.content);
  } catch {
    const err = new Error('The AI planner returned invalid JSON');
    err.status = 502;
    throw err;
  }
}

export default async function handler(req, res) {
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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { goal, why, vision, obstacle, hours } = body ?? {};
  if (!goal?.trim()) return res.status(400).json({ error: 'Goal is required' });

  const hoursNum = { '1-2': 2, '3-5': 4, '5-10': 7, '10+': 12 }[hours] || 5;
  const intensity = hoursNum <= 2 ? 'light' : hoursNum <= 5 ? 'moderate' : 'intensive';

  try {
    const plan = await callOpenAI({ goal, why, vision, obstacle, hours, intensity });
    return res.status(200).json({ plan: { ...plan, intensity } });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'Failed to generate plan' });
  }
}
