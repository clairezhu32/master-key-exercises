const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const VOICE = 'shimmer'; // soft, warm female — closest built-in match to the prior narrator
const VOICE_INSTRUCTIONS = 'Speak Mandarin Chinese in a warm, soothing, unhurried voice, as if calmly guiding someone through a meditation exercise.';
const MAX_CHARS = 4096; // OpenAI audio/speech input limit

const rateLimitMap = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 60_000; // 1-minute sliding window
const RATE_MAX = 15;           // max requests per window (supports up to 7 segments × 2)

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/master-key-exercises[^.]*\.vercel\.app$/.test(origin)) return true;
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
    return res.status(405).json({ error: '方法不允许' });
  }

  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: '禁止访问' });
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitMap.get(ip) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_MAX) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - entry.windowStart)) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ error: '请求过于频繁，请稍候' });
  }
  if (rateLimitMap.size > 2000) {
    const cutoff = now - RATE_WINDOW_MS;
    for (const [k, v] of rateLimitMap) if (v.windowStart < cutoff) rateLimitMap.delete(k);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY env var not set');
    return res.status(500).json({ error: '语音服务未配置' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: '无效的请求体' });
  }

  const { text } = body ?? {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text 字段是必须的' });
  }
  if (text.length > MAX_CHARS) {
    return res.status(400).json({ error: `text 不能超过 ${MAX_CHARS} 个字符` });
  }

  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: VOICE,
      input: text.trim(),
      instructions: VOICE_INSTRUCTIONS,
      response_format: 'mp3',
      speed: 1,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => upstream.statusText);
    console.error(`OpenAI TTS ${upstream.status}: ${detail}`);
    const clientStatus = upstream.status >= 500 ? 502 : 400;
    return res.status(clientStatus).json({ error: '语音服务暂时不可用' });
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
