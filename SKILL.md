---
name: voice-chat
description: Run a lightweight HTTP bridge server that connects mobile voice apps (like ClawVoice for Android) to an OpenClaw agent. Use when setting up voice input from a phone, configuring the voice chat bridge, or troubleshooting the voice-to-text-to-agent pipeline.
---

# Voice Chat Bridge

Voice conversation bridge connecting mobile apps to OpenClaw. Supports two modes:

1. **Text mode** — client does speech-to-text locally, sends text to server
2. **Streaming audio mode** — client streams raw audio to server, which transcribes via faster-whisper sidecar (lower latency, more natural flow)

## Architecture

```
┌──────────────┐     WebSocket      ┌──────────────┐     HTTP      ┌──────────────┐
│  ClawVoice   │ ←────────────────→ │  Node.js     │ ←──────────→  │  faster-     │
│  Android App │   audio/text/      │  Bridge      │  transcribe   │  whisper     │
│              │   sentences        │  (server.js) │  /finalize    │  sidecar     │
└──────────────┘                    └──────┬───────┘               └──────────────┘
                                           │
                                    Chat Completions
                                           │
                                    ┌──────┴───────┐
                                    │   OpenClaw   │
                                    │   Gateway    │
                                    └──────────────┘
```

## Prerequisites

1. **Node.js** (v18+) for the bridge server
2. **Python 3.10+** for the whisper sidecar
3. **OpenClaw gateway** with Chat Completions endpoint enabled:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

## Quick Start

### Automated Setup

```bash
./scripts/setup.sh
```

The setup script will:
- Install Node.js and Python dependencies
- Prompt for configuration (gateway URL, tokens, etc.)
- Create and start systemd services for both the bridge and whisper sidecar

### Manual Setup

```bash
# 1. Install Node.js dependencies
npm install --omit=dev

# 2. Set up whisper sidecar
cd whisper-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

# 3. Start whisper sidecar
cd whisper-service
venv/bin/python whisper_service.py  # Listens on :8790

# 4. Start bridge server
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token"
node scripts/server.js              # Listens on :8766
```

## API

### HTTP Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | No | Liveness check: `{"status":"ok","agent":"main","name":"Sancho","streaming":true}` |
| `POST /text` | Yes | Send text, get full response: `{"text":"hello"}` → `{"response":"Hey!"}` |
| `GET /greet` | Yes | Get a contextual greeting: `{"greeting":"Good afternoon!"}` |

### WebSocket (`/ws`)

Connect with auth token as query param: `wss://host/ws?token=xxx`

#### Client → Server

| Type | Fields | Description |
|---|---|---|
| `text` | `text` | Send text for LLM response |
| `greet` | — | Request a spoken greeting |
| `audio` | `data` (base64 PCM), `sampleRate` | Stream audio chunk to whisper sidecar |
| `end_of_speech` | — | Signal end of utterance; triggers final transcription → LLM |

#### Server → Client

| Type | Fields | Description |
|---|---|---|
| `greeting` | `text` | Spoken greeting |
| `transcript` | `text`, `final` | Partial (`final:false`) or final (`final:true`) transcription |
| `sentence` | `text`, `index` | Streamed sentence from LLM response |
| `done` | `fullText` | LLM response complete |
| `error` | `error` | Error message |

### Conversation Flow (Streaming Audio)

```
App                         Bridge                    Whisper         LLM
 │──── audio chunk ─────────→│                           │              │
 │──── audio chunk ─────────→│── chunk ─────────────────→│              │
 │←─── transcript (partial) ─│←─ partial text ──────────│              │
 │──── audio chunk ─────────→│── chunk ─────────────────→│              │
 │──── end_of_speech ───────→│── finalize ──────────────→│              │
 │←─── transcript (final) ──│←─ final text ─────────────│              │
 │                           │── chat/completions (stream)────────────→│
 │←─── sentence[0] ─────────│←─────────────── tokens ──────────────── │
 │←─── sentence[1] ─────────│                                         │
 │←─── done ────────────────│                                         │
```

## Environment Variables

### Bridge Server (server.js)

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Gateway auth token |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway URL |
| `VOICE_CHAT_PORT` | `8766` | Server listen port |
| `VOICE_CHAT_BIND` | `0.0.0.0` | Bind address |
| `OPENCLAW_AGENT_ID` | `main` | Agent to route messages to |
| `VOICE_CHAT_SYSTEM` | *(auto)* | System prompt override (default: voice-optimized prompt) |
| `VOICE_CHAT_AGENT_NAME` | `Assistant` | Agent name in health check and greeting |
| `VOICE_CHAT_TOKEN` | *(none)* | Client auth token (if unset, no auth) |
| `VOICE_CHAT_USER` | `voice-chat` | Stable user ID for session continuity |
| `VOICE_CHAT_TIMEOUT` | `60000` | Gateway request timeout (ms) |
| `VOICE_CHAT_GREETING` | *(auto)* | Static greeting override (default: contextual) |
| `WHISPER_SERVICE_URL` | `http://localhost:8790` | Whisper sidecar URL |

### Whisper Sidecar (whisper_service.py)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `base` | Model size: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_PORT` | `8790` | Listen port |
| `WHISPER_DEVICE` | `cpu` | Device: `cpu` or `cuda` |
| `WHISPER_COMPUTE_TYPE` | `int8` | Compute type: `int8`, `float16`, `float32` |

## Running as Services

### Using setup.sh (recommended)

```bash
./scripts/setup.sh
```

### Manual systemd setup

```bash
# Whisper sidecar
cat > ~/.config/systemd/user/whisper-sidecar.service << 'EOF'
[Unit]
Description=Whisper Sidecar (faster-whisper transcription)
After=network.target

[Service]
ExecStart=/path/to/whisper-service/venv/bin/python /path/to/whisper-service/whisper_service.py
Environment=WHISPER_MODEL=base
Environment=WHISPER_PORT=8790
Environment=WHISPER_DEVICE=cpu
Environment=WHISPER_COMPUTE_TYPE=int8
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Voice chat bridge
cat > ~/.config/systemd/user/voice-chat.service << 'EOF'
[Unit]
Description=Voice Chat Bridge (OpenClaw)
After=network.target whisper-sidecar.service
Wants=whisper-sidecar.service

[Service]
ExecStart=/usr/bin/node /path/to/scripts/server.js
Environment=OPENCLAW_GATEWAY_TOKEN=your-token
Environment=OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
Environment=WHISPER_SERVICE_URL=http://localhost:8790
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now whisper-sidecar voice-chat
```

## Voice Response Behavior

The bridge includes a voice-optimized system prompt and output sanitizer:

- **Brief responses** — 2-3 sentences max unless detail is requested
- **No emoji** — stripped from output (TTS reads them by name)
- **No markdown** — no headers, bold, bullets, code blocks
- **No URLs** — stripped from output
- **Natural language** — numbers spoken out ("two hundred", not "200")

Override the system prompt with `VOICE_CHAT_SYSTEM` if needed.

## Android App (ClawVoice)

The companion app ([ClawVoice](https://github.com/mattmanning/clawvoice)) provides:

- **Streaming audio mode** — Silero VAD for end-of-speech detection, streams PCM audio over WebSocket
- **On-device TTS** — Piper TTS via sherpa-onnx with downloadable voice models, or system TTS
- **Sentence-level streaming** — starts speaking the first sentence while the rest generates
- **Home screen widget** for quick access

Set the server URL in app settings to your bridge URL (e.g. `https://claw-voice.manning.casa`).

## Authentication

Set `VOICE_CHAT_TOKEN` to require auth on all endpoints except `/health`.

- **HTTP**: `Authorization: Bearer <token>`
- **WebSocket**: `wss://host/ws?token=<token>`

`/health` is unauthenticated so apps can discover the agent before authenticating.

## Troubleshooting

- **502 from bridge**: Gateway unreachable or Chat Completions endpoint not enabled
- **Transcription errors**: Check whisper sidecar logs: `journalctl --user -u whisper-sidecar -f`
- **Whisper sidecar down**: `systemctl --user status whisper-sidecar` — text mode still works without it
- **Slow transcription**: Try `WHISPER_MODEL=tiny` for faster (less accurate) results, or `small` for better accuracy
- **401 from gateway**: Token mismatch — verify `OPENCLAW_GATEWAY_TOKEN`
- **Timeout**: Increase `VOICE_CHAT_TIMEOUT`; also check OkHttp timeout in the Android app
- **Can't connect from phone**: Ensure `VOICE_CHAT_BIND=0.0.0.0` and use a tunnel or same network
