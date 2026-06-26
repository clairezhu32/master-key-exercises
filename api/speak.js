const VOICE_ID = 'cgSgspJ2msm6clMCkdW9'; // Liam — calm, clear
const MODEL_ID = 'eleven_turbo_v2_5';
const MAX_CHARS = 5000;

// Per-instance in-memory rate limiter (one request per IP per 30 s).
// Not shared across Vercel function instances but provides meaningful
// protection against single-client abuse within an instance's lifetime.
const rateLimitMap = new Map(); // ip → last-request timestamp (ms)
const RATE_WINDOW_MS = 30_000;


function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Local dev
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  // Any Vercel preview or production deployment for this project
  if (/^https:\/\/master-key-exercises[^.]*\.vercel\.app$/.test(origin)) return true;
  // Optional custom domain via env var
  const custom = process.env.ALLOWED_ORIGIN;
  if (custom && origin === custom) return true;
  return false;
}

function getClientIp(req) {
  return (
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    'unknown'
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Origin allowlist ───────────────────────
  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Per-IP rate limit ──────────────────────
  const ip = getClientIp(req);
  const now = Date.now();
  const last = rateLimitMap.get(ip) ?? 0;
  if (now - last < RATE_WINDOW_MS) {
    res.setHeader('Retry-After', Math.ceil((RATE_WINDOW_MS - (now - last)) / 1000));
    return res.status(429).json({ error: 'Too many requests — please wait a moment' });
  }
  rateLimitMap.set(ip, now);
  // Prune old entries to prevent unbounded map growth
  if (rateLimitMap.size > 2000) {
    const cutoff = now - RATE_WINDOW_MS * 2;
    for (const [k, v] of rateLimitMap) if (v < cutoff) rateLimitMap.delete(k);
  }

  // ── API key ────────────────────────────────
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('ELEVENLABS_API_KEY env var not set');
    return res.status(500).json({ error: 'Voice service not configured' });
  }

  // ── Body parsing & validation ──────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { text } = body ?? {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_CHARS) {
    return res.status(400).json({ error: `text must be ${MAX_CHARS} chars or fewer` });
  }

  // ── ElevenLabs request ─────────────────────
  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: MODEL_ID,
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1 },
      }),
    }
  );

  if (!upstream.ok) {
    // Log detail server-side only; never leak upstream body to the client
    const detail = await upstream.text().catch(() => upstream.statusText);
    console.error(`ElevenLabs ${upstream.status}: ${detail}`);
    const clientStatus = upstream.status >= 500 ? 502 : 400;
    return res.status(clientStatus).json({ error: 'Voice service unavailable' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}
