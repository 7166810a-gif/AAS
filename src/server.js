'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const OpenAI = require('openai');
const { toFile } = require('openai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_SESSIONS = 1500;
const sessions = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));

let openaiClient;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function timingSafeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getRequestData(req) {
  return { ...(req.query || {}), ...(req.body || {}) };
}

function isSafeRecordingPath(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 500) return false;
  const value = input.trim();
  if (/^(https?:)?\/\//i.test(value)) return false;
  if (/[?#\\\u0000-\u001f]/.test(value)) return false;
  const normalized = value.replace(/^ivr2:/i, '').replace(/^\/+/, '');
  return normalized.length > 0 && normalized.split('/').every(part => part && part !== '.' && part !== '..');
}

function toYemotApiPath(recordingPath) {
  const clean = String(recordingPath || '').trim().replace(/^ivr2:/i, '').replace(/^\/+/, '');
  if (!isSafeRecordingPath(clean)) throw new Error('Invalid recording path');
  return 'ivr2:/' + clean;
}

function buildIvrResponse(text) {
  const safe = String(text || 'לא הצלחתי ליצור תשובה. אנא נסו שוב.')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 850);
  return 'read=t-' + (safe || 'לא התקבלה תשובה');
}

function sessionIdFromParams(data) {
  const candidates = [
    data.call_id, data.callid, data.CallId, data.api_call_id,
    data.apiCallId, data.CALLID, data.phone, data.PHONE,
    data.phone_number, data.caller
  ];
  const found = candidates.find(value => typeof value === 'string' && value.trim());
  return found ? String(found).trim().slice(0, 120) : null;
}

function pruneSessions() {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (now - value.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (!oldestKey) break;
    sessions.delete(oldestKey);
  }
}

function getSession(sessionId) {
  if (!sessionId) return [];
  pruneSessions();
  const session = sessions.get(sessionId);
  if (!session) return [];
  session.updatedAt = Date.now();
  return session.messages.slice(-8);
}

function saveSession(sessionId, messages) {
  if (!sessionId) return;
  pruneSessions();
  sessions.set(sessionId, {
    updatedAt: Date.now(),
    messages: messages.slice(-8)
  });
}

function requireIvrAccess(req, res, next) {
  const expected = process.env.ACCESS_KEY;
  if (!expected) {
    return res.status(200).type('text/plain').send(buildIvrResponse('השירות אינו מוגדר עדיין. נא לפנות למנהל המערכת.'));
  }
  const data = getRequestData(req);
  const supplied = String(data.key || req.get('x-access-key') || '');
  if (!timingSafeEqualText(supplied, expected)) {
    return res.status(200).type('text/plain').send(buildIvrResponse('הגישה לשירות נדחתה.'));
  }
  next();
}

async function downloadYemotRecording(recordingPath, token) {
  const apiBase = (process.env.YEMOT_API_BASE || 'https://www.call2all.co.il/ym/api').replace(/\/+$/, '');
  const url = new URL(apiBase + '/DownloadFile');
  url.searchParams.set('token', token);
  url.searchParams.set('path', toYemotApiPath(recordingPath));

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error('Yemot recording download failed with HTTP ' + response.status);
  }

  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Empty recording received');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('Recording exceeds size limit');
  if (contentType.includes('application/json') || buffer.subarray(0, 1).toString() === '{') {
    throw new Error('Yemot API returned an error instead of an audio file');
  }
  return { buffer, contentType };
}

function audioMetadata(recordingPath, contentType) {
  const ext = (String(recordingPath).split('.').pop() || '').toLowerCase();
  const map = {
    wav: { mime: 'audio/wav', name: 'recording.wav' },
    mp3: { mime: 'audio/mpeg', name: 'recording.mp3' },
    ogg: { mime: 'audio/ogg', name: 'recording.ogg' },
    m4a: { mime: 'audio/mp4', name: 'recording.m4a' },
    mp4: { mime: 'audio/mp4', name: 'recording.mp4' },
    webm: { mime: 'audio/webm', name: 'recording.webm' }
  };
  const known = map[ext] || map.wav;
  if (contentType && contentType.startsWith('audio/')) known.mime = contentType.split(';')[0];
  return known;
}

async function transcribeAudio(client, audio, recordingPath) {
  const meta = audioMetadata(recordingPath, audio.contentType);
  const file = await toFile(new Uint8Array(audio.buffer), meta.name, { type: meta.mime });
  const result = await client.audio.transcriptions.create({
    file,
    model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    language: 'he'
  });
  const transcript = String(result.text || '').trim();
  if (!transcript) throw new Error('No speech was recognized');
  return transcript;
}

async function generateAnswer(client, transcript, sessionId) {
  const previous = getSession(sessionId);
  const systemPrompt = process.env.SYSTEM_PROMPT ||
    'אתה עוזר טלפוני מועיל, מדויק ואדיב. השב בעברית טבעית, במשפטים קצרים וברורים שמתאימים להקראה בטלפון. אם אינך יודע תשובה, אמור זאת בפשטות.';
  const messages = [
    { role: 'system', content: systemPrompt },
    ...previous,
    { role: 'user', content: transcript }
  ];

  const result = await client.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    messages,
    temperature: 0.4,
    max_tokens: 300
  });
  const answer = String(result.choices?.[0]?.message?.content || '').trim();
  if (!answer) throw new Error('AI returned an empty answer');

  saveSession(sessionId, [
    ...previous,
    { role: 'user', content: transcript },
    { role: 'assistant', content: answer }
  ]);
  return answer;
}

app.get('/', (_req, res) => {
  res.type('text/plain; charset=utf-8').send('AAS IVR AI is running. See /health for status.');
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'aas-yemot-ivr-ai',
    configured: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      yemot: Boolean(process.env.YEMOT_TOKEN),
      accessKey: Boolean(process.env.ACCESS_KEY),
      admin: Boolean(process.env.ADMIN_PASSWORD)
    },
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get('/admin', (req, res) => {
  const password = process.env.ADMIN_PASSWORD;
  const header = req.get('authorization') || '';
  const encoded = header.startsWith('Basic ') ? header.slice(6) : '';
  let supplied = '';
  try {
    supplied = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':');
  } catch {}
  if (!password || !timingSafeEqualText(supplied, password)) {
    res.set('WWW-Authenticate', 'Basic realm="AAS IVR Admin"');
    return res.status(401).type('text/plain').send('Authentication required');
  }

  res.type('html').send(`<!doctype html>
<html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AAS — ניהול</title>
<style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;background:#f6f7f9;color:#172033}main{background:white;padding:28px;border-radius:16px;box-shadow:0 4px 20px #0001}h1{margin-top:0}pre{white-space:pre-wrap;background:#f0f3f7;padding:14px;border-radius:10px}a{color:#2457b8}</style>
<main><h1>מערכת AAS — ניהול</h1><p>השרת פעיל. מפתחות אינם מוצגים בפאנל.</p><p><a href="/health">בדיקת תקינות</a></p><pre id="status">טוען מצב...</pre></main>
<script>fetch('/health').then(r=>r.json()).then(x=>document.getElementById('status').textContent=JSON.stringify(x,null,2)).catch(()=>document.getElementById('status').textContent='לא ניתן לטעון מצב');</script>`);
});

async function ivrHandler(req, res) {
  const data = getRequestData(req);
  const recordingPath = String(data.rapi || data.recording || data.path || '').trim();
  const token = process.env.YEMOT_TOKEN || String(data.token || '').trim();

  if (!token) {
    return res.status(503).type('text/plain; charset=utf-8').send(buildIvrResponse('חסר טוקן התחברות לימות המשיח בשרת.'));
  }
  if (!isSafeRecordingPath(recordingPath)) {
    return res.status(400).type('text/plain; charset=utf-8').send(buildIvrResponse('לא התקבל נתיב הקלטה תקין.'));
  }

  try {
    const client = getOpenAI();
    const audio = await downloadYemotRecording(recordingPath, token);
    const transcript = await transcribeAudio(client, audio, recordingPath);
    const sessionId = sessionIdFromParams(data);
    const answer = await generateAnswer(client, transcript, sessionId);

    res.set('Cache-Control', 'no-store');
    return res.type('text/plain; charset=utf-8').send(buildIvrResponse(answer));
  } catch (error) {
    // Do not log API keys, recording contents, phone numbers, or full provider responses.
    console.error('[ivr] request failed:', error?.message || 'unknown error');
    const message = error?.message === 'No speech was recognized'
      ? 'לא זיהיתי דיבור בהקלטה. אפשר לנסות שוב.'
      : 'אירעה תקלה בעיבוד השאלה. אנא נסו שוב בעוד רגע.';
    return res.status(200).type('text/plain; charset=utf-8').send(buildIvrResponse(message));
  }
}

app.all(['/run_transcription', '/api/ivr'], requireIvrAccess, (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.sendStatus(405);
  return ivrHandler(req, res);
});

app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('AAS IVR AI listening on port ' + PORT);
  });
}

module.exports = {
  app,
  buildIvrResponse,
  isSafeRecordingPath,
  toYemotApiPath,
  timingSafeEqualText,
  sessionIdFromParams
};
