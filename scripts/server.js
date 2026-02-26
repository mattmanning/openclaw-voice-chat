#!/usr/bin/env node
/**
 * Voice Chat Bridge Server
 *
 * Lightweight HTTP server that bridges a mobile voice app (or any HTTP client)
 * to an OpenClaw gateway via the OpenAI Chat Completions API.
 *
 * POST /text   — {"text":"..."} → agent reply
 * GET  /health — liveness check
 *
 * Environment / CLI config:
 *   OPENCLAW_GATEWAY_URL   (default http://127.0.0.1:18789)
 *   OPENCLAW_GATEWAY_TOKEN (required)
 *   VOICE_CHAT_PORT        (default 8766)
 *   VOICE_CHAT_BIND        (default 0.0.0.0)
 *   OPENCLAW_AGENT_ID      (default main)
 *   VOICE_CHAT_SYSTEM      (optional system prompt override)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- Config --------------------------------------------------------------- //

const PORT = parseInt(process.env.VOICE_CHAT_PORT || '8766', 10);
const BIND = process.env.VOICE_CHAT_BIND || '0.0.0.0';
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
const SYSTEM_PROMPT = process.env.VOICE_CHAT_SYSTEM || null;
const READ_TIMEOUT = parseInt(process.env.VOICE_CHAT_TIMEOUT || '60000', 10);
const AGENT_NAME = process.env.VOICE_CHAT_AGENT_NAME || 'Assistant';

if (!GATEWAY_TOKEN) {
  console.error('ERROR: OPENCLAW_GATEWAY_TOKEN is required.');
  console.error('Set it to your gateway auth token (from openclaw.json gateway.auth.token).');
  process.exit(1);
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

/**
 * Forward a user message to the OpenClaw gateway's Chat Completions endpoint
 * and return the assistant's reply text.
 */
async function askGateway(text) {
  const url = new URL('/v1/chat/completions', GATEWAY_URL);
  const transport = url.protocol === 'https:' ? https : http;

  const messages = [];
  if (SYSTEM_PROMPT) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
  }
  messages.push({ role: 'user', content: text });

  const payload = JSON.stringify({
    model: `openclaw:${AGENT_ID}`,
    messages,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: READ_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`Gateway ${res.statusCode}: ${body.slice(0, 500)}`));
          }
          try {
            const parsed = JSON.parse(body);
            const reply =
              parsed.choices?.[0]?.message?.content || 'No response from agent.';
            resolve(reply);
          } catch (e) {
            reject(new Error(`Bad gateway response: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gateway request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// --- Server --------------------------------------------------------------- //

const server = http.createServer(async (req, res) => {
  // CORS headers for flexibility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { status: 'ok', agent: AGENT_ID, name: AGENT_NAME });
  }

  // Main text endpoint
  if (req.method === 'POST' && req.url === '/text') {
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw);
      if (!text || typeof text !== 'string') {
        return jsonResponse(res, 400, { status: 'error', error: 'Missing "text" field' });
      }

      console.log(`[${new Date().toISOString()}] → ${text.slice(0, 120)}`);

      const response = await askGateway(text);

      console.log(`[${new Date().toISOString()}] ← ${response.slice(0, 120)}`);

      return jsonResponse(res, 200, { input: text, status: 'ok', response });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
      return jsonResponse(res, 502, {
        status: 'error',
        error: err.message,
      });
    }
  }

  jsonResponse(res, 404, { status: 'error', error: 'Not found' });
});

server.listen(PORT, BIND, () => {
  console.log(`Voice Chat Bridge listening on ${BIND}:${PORT}`);
  console.log(`  Gateway: ${GATEWAY_URL} (agent: ${AGENT_ID})`);
  console.log(`  Name: ${AGENT_NAME}`);
  console.log(`  Timeout: ${READ_TIMEOUT}ms`);
});
