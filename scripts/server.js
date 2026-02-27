#!/usr/bin/env node
/**
 * Voice Chat Bridge Server
 *
 * Lightweight HTTP + WebSocket server that bridges a mobile voice app
 * to an OpenClaw gateway via the OpenAI Chat Completions API.
 *
 * HTTP (backward compatible):
 *   POST /text   — {"text":"..."} → full agent reply
 *   GET  /health — liveness check + agent name
 *
 * WebSocket (streaming):
 *   Connect to ws://<host>:<port>/ws
 *   Send:    {"type":"text","text":"..."}
 *   Receive: {"type":"sentence","text":"First sentence.","index":0}
 *             {"type":"sentence","text":"Second sentence.","index":1}
 *             {"type":"done","fullText":"..."}
 *   Error:   {"type":"error","error":"..."}
 *
 * Environment:
 *   OPENCLAW_GATEWAY_URL   (default http://127.0.0.1:18789)
 *   OPENCLAW_GATEWAY_TOKEN (required)
 *   VOICE_CHAT_PORT        (default 8766)
 *   VOICE_CHAT_BIND        (default 0.0.0.0)
 *   OPENCLAW_AGENT_ID      (default main)
 *   VOICE_CHAT_SYSTEM      (optional system prompt override)
 *   VOICE_CHAT_AGENT_NAME  (default Assistant)
 *   VOICE_CHAT_TOKEN       (optional client auth token)
 *   VOICE_CHAT_USER        (default voice-chat, for session continuity)
 *   VOICE_CHAT_TIMEOUT     (default 60000ms)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

// --- Config --------------------------------------------------------------- //

const PORT = parseInt(process.env.VOICE_CHAT_PORT || '8766', 10);
const BIND = process.env.VOICE_CHAT_BIND || '0.0.0.0';
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
const SYSTEM_PROMPT = process.env.VOICE_CHAT_SYSTEM || null;
const READ_TIMEOUT = parseInt(process.env.VOICE_CHAT_TIMEOUT || '60000', 10);
const AGENT_NAME = process.env.VOICE_CHAT_AGENT_NAME || 'Assistant';
const AUTH_TOKEN = process.env.VOICE_CHAT_TOKEN || null;
const SESSION_USER = process.env.VOICE_CHAT_USER || 'voice-chat';

if (!GATEWAY_TOKEN) {
  console.error('ERROR: OPENCLAW_GATEWAY_TOKEN is required.');
  console.error('Set it to your gateway auth token (from openclaw.json gateway.auth.token).');
  process.exit(1);
}

// --- Sentence splitter ---------------------------------------------------- //

/** Sentence-ending punctuation pattern. Handles ., !, ?, and common abbrev edge cases. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z"\u201c])|(?<=[.!?])$/;

/**
 * Incrementally split a growing text buffer into complete sentences.
 * Returns { sentences: string[], remainder: string }
 */
function extractSentences(buffer) {
  const sentences = [];
  let remaining = buffer;

  while (true) {
    const match = SENTENCE_END.exec(remaining);
    if (!match) break;

    const sentenceEnd = match.index;
    const sentence = remaining.slice(0, sentenceEnd).trim();
    if (sentence) sentences.push(sentence);
    remaining = remaining.slice(sentenceEnd + match[0].length);
  }

  return { sentences, remainder: remaining };
}

// --- Helpers -------------------------------------------------------------- //

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return token === AUTH_TOKEN;
}

function checkAuthFromUrl(url) {
  if (!AUTH_TOKEN) return true;
  try {
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token') === AUTH_TOKEN;
  } catch {
    return false;
  }
}

// --- Gateway communication ------------------------------------------------ //

function buildMessages(text) {
  const messages = [];
  if (SYSTEM_PROMPT) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
  }
  messages.push({ role: 'user', content: text });
  return messages;
}

/**
 * Non-streaming request to gateway (for HTTP /text endpoint).
 */
async function askGateway(text) {
  const url = new URL('/v1/chat/completions', GATEWAY_URL);
  const transport = url.protocol === 'https:' ? https : http;

  const payload = JSON.stringify({
    model: `openclaw:${AGENT_ID}`,
    messages: buildMessages(text),
    stream: false,
    user: SESSION_USER,
  });

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: READ_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`Gateway ${res.statusCode}: ${body.slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.choices?.[0]?.message?.content || 'No response from agent.');
        } catch (e) {
          reject(new Error(`Bad gateway response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gateway request timed out')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Streaming request to gateway (for WebSocket).
 * Calls onChunk(tokenText) for each content delta, onDone() when finished.
 */
function streamGateway(text, onChunk, onDone, onError) {
  const url = new URL('/v1/chat/completions', GATEWAY_URL);
  const transport = url.protocol === 'https:' ? https : http;

  const payload = JSON.stringify({
    model: `openclaw:${AGENT_ID}`,
    messages: buildMessages(text),
    stream: true,
    user: SESSION_USER,
  });

  const req = transport.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: READ_TIMEOUT,
  }, (res) => {
    if (res.statusCode !== 200) {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => onError(new Error(`Gateway ${res.statusCode}: ${body.slice(0, 500)}`)));
      return;
    }

    let sseBuffer = '';

    res.on('data', (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          onDone();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {
          // skip malformed SSE lines
        }
      }
    });

    res.on('end', () => {
      // Process any remaining buffer
      if (sseBuffer.startsWith('data: ')) {
        const data = sseBuffer.slice(6).trim();
        if (data === '[DONE]') {
          onDone();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {}
      }
      onDone();
    });

    res.on('error', onError);
  });

  req.on('error', onError);
  req.on('timeout', () => { req.destroy(); onError(new Error('Gateway request timed out')); });
  req.write(payload);
  req.end();

  return req;
}

// --- HTTP Server ---------------------------------------------------------- //

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check (unauthenticated)
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { status: 'ok', agent: AGENT_ID, name: AGENT_NAME, streaming: true });
  }

  // Auth check for all other HTTP endpoints
  if (AUTH_TOKEN && !checkAuth(req)) {
    return jsonResponse(res, 401, { status: 'error', error: 'Unauthorized' });
  }

  // Non-streaming text endpoint (backward compatible)
  if (req.method === 'POST' && req.url === '/text') {
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw);
      if (!text || typeof text !== 'string') {
        return jsonResponse(res, 400, { status: 'error', error: 'Missing "text" field' });
      }
      console.log(`[${ts()}] HTTP → ${text.slice(0, 120)}`);
      const response = await askGateway(text);
      console.log(`[${ts()}] HTTP ← ${response.slice(0, 120)}`);
      return jsonResponse(res, 200, { input: text, status: 'ok', response });
    } catch (err) {
      console.error(`[${ts()}] HTTP ERROR:`, err.message);
      return jsonResponse(res, 502, { status: 'error', error: err.message });
    }
  }

  jsonResponse(res, 404, { status: 'error', error: 'Not found' });
});

// --- WebSocket Server ----------------------------------------------------- //

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Auth: check token from query param (ws://host:port/ws?token=xxx)
  if (AUTH_TOKEN && !checkAuthFromUrl(req.url)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log(`[${ts()}] WS connected`);
  let activeRequest = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      wsSend(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (msg.type !== 'text' || !msg.text) {
      wsSend(ws, { type: 'error', error: 'Expected {"type":"text","text":"..."}' });
      return;
    }

    const text = msg.text;
    console.log(`[${ts()}] WS → ${text.slice(0, 120)}`);

    // Cancel any in-flight request
    if (activeRequest) {
      try { activeRequest.destroy(); } catch {}
      activeRequest = null;
    }

    let tokenBuffer = '';
    let sentenceIndex = 0;
    let fullText = '';
    let done = false;

    activeRequest = streamGateway(
      text,
      // onChunk
      (token) => {
        if (done) return;
        fullText += token;
        tokenBuffer += token;

        const { sentences, remainder } = extractSentences(tokenBuffer);
        tokenBuffer = remainder;

        for (const sentence of sentences) {
          console.log(`[${ts()}] WS ← [${sentenceIndex}] ${sentence.slice(0, 80)}`);
          wsSend(ws, { type: 'sentence', text: sentence, index: sentenceIndex++ });
        }
      },
      // onDone
      () => {
        if (done) return;
        done = true;
        activeRequest = null;

        // Flush any remaining text as a final sentence
        const remaining = tokenBuffer.trim();
        if (remaining) {
          console.log(`[${ts()}] WS ← [${sentenceIndex}] ${remaining.slice(0, 80)}`);
          wsSend(ws, { type: 'sentence', text: remaining, index: sentenceIndex++ });
        }

        console.log(`[${ts()}] WS ← done (${sentenceIndex} sentences)`);
        wsSend(ws, { type: 'done', fullText });
      },
      // onError
      (err) => {
        if (done) return;
        done = true;
        activeRequest = null;
        console.error(`[${ts()}] WS ERROR:`, err.message);
        wsSend(ws, { type: 'error', error: err.message });
      }
    );
  });

  ws.on('close', () => {
    console.log(`[${ts()}] WS disconnected`);
    if (activeRequest) {
      try { activeRequest.destroy(); } catch {}
      activeRequest = null;
    }
  });
});

function wsSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function ts() {
  return new Date().toISOString();
}

// --- Start ---------------------------------------------------------------- //

server.listen(PORT, BIND, () => {
  console.log(`Voice Chat Bridge listening on ${BIND}:${PORT}`);
  console.log(`  Gateway: ${GATEWAY_URL} (agent: ${AGENT_ID})`);
  console.log(`  Name: ${AGENT_NAME}`);
  console.log(`  Session user: ${SESSION_USER}`);
  console.log(`  Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled (set VOICE_CHAT_TOKEN to enable)'}`);
  console.log(`  Timeout: ${READ_TIMEOUT}ms`);
  console.log(`  WebSocket: ws://${BIND}:${PORT}/ws`);
});
