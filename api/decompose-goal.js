const rateLimitMap = new Map();
const RATE_WINDOW_MS = 3_600_000;
const RATE_MAX = 10;

// Use Google's "-latest" alias rather than a pinned version — pinned model IDs
// can lose availability for newer API keys/projects even while still listed
// in the models catalog. Override via env var if needed.
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
      description: 'Exactly 12 weeks — a full execution cadence. Front-load early weeks on targets/access/outreach and later weeks on prep/close, matching how this specific goal actually plays out over 90 days.',
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

async function callGemini(goalData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI planning is not configured');
    err.status = 500;
    throw err;
  }

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

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Gemini ${res.status}: ${detail}`);
    const err = new Error('The AI planner is temporarily unavailable');
    err.status = 502;
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
    const plan = await callGemini({ goal, why, vision, obstacle, hours, intensity });
    return res.status(200).json({ plan: { ...plan, intensity } });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'Failed to generate plan' });
  }
}
