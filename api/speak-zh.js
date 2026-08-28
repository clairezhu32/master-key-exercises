const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = 'Achernar'; // documented as a "Soft" prebuilt voice — closest match to the prior narrator
const STYLE_PREFIX = 'Say the following Mandarin Chinese text in a warm, soothing, unhurried voice, as if calmly guiding someone through a meditation exercise: ';
const MAX_CHARS = 4096;

const rateLimitMap = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 60_000; // 1-minute sliding window
const RATE_MAX = 15;           // max requests per window (supports up to 7 segments × 2)

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/(master-key-exercises|lucky-action-plan)[^.]*\.vercel\.app$/.test(origin)) return true;
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

// Gemini TTS returns raw PCM (base64, mono, 16-bit) with the sample rate
// stated in the mimeType (e.g. "audio/L16;codec=pcm;rate=24000"). Browsers
// can't play raw PCM directly, so wrap it in a minimal WAV header.
function pcmToWav(pcmBuffer, sampleRate, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY env var not set');
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

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: STYLE_PREFIX + text.trim() }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      }),
    }
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => upstream.statusText);
    console.error(`Gemini TTS ${upstream.status}: ${detail}`);
    const clientStatus = upstream.status >= 500 ? 502 : 400;
    return res.status(clientStatus).json({ error: '语音服务暂时不可用' });
  }

  const data = await upstream.json();
  const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    console.error('Gemini TTS: no audio in response', JSON.stringify(data).slice(0, 500));
    return res.status(502).json({ error: '语音服务未返回音频' });
  }

  const rateMatch = /rate=(\d+)/.exec(inlineData.mimeType || '');
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const wav = pcmToWav(Buffer.from(inlineData.data, 'base64'), sampleRate);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.end(wav);
}
