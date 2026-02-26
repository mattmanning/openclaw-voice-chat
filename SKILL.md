---
name: voice-chat
description: Run a lightweight HTTP bridge server that connects mobile voice apps (like ClawVoice for Android) to an OpenClaw agent. Use when setting up voice input from a phone, configuring the voice chat bridge, or troubleshooting the voice-to-text-to-agent pipeline.
---

# Voice Chat Bridge

HTTP server bridging mobile voice apps to OpenClaw via the Chat Completions API.

## Prerequisites

1. OpenClaw gateway running with the Chat Completions endpoint enabled:

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

Apply via `openclaw config patch` or the `gateway` tool's `config.patch` action.

2. Gateway auth token (from `gateway.auth.token` in `openclaw.json`).

## Quick Start

```bash
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token"
node scripts/server.js
```

Server listens on `0.0.0.0:8766` by default.

## API

### `POST /text`
```json
{"text": "What's the weather like?"}
```
Response:
```json
{"input": "What's the weather like?", "status": "ok", "response": "It's 58°F and rainy."}
```

### `GET /health`
Returns `{"status": "ok", "agent": "main", "name": "Sancho"}`. The `name` field is set via `VOICE_CHAT_AGENT_NAME` — useful for the client to display the agent's name.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Gateway auth token |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway URL |
| `VOICE_CHAT_PORT` | `8766` | Server listen port |
| `VOICE_CHAT_BIND` | `0.0.0.0` | Bind address |
| `OPENCLAW_AGENT_ID` | `main` | Agent to route messages to |
| `VOICE_CHAT_SYSTEM` | *(none)* | Optional system prompt override |
| `VOICE_CHAT_AGENT_NAME` | `Assistant` | Agent name returned by `/health` |
| `VOICE_CHAT_TIMEOUT` | `60000` | Gateway request timeout (ms) |

## Running as a Service

Create a systemd user service for persistence:

```bash
cat > ~/.config/systemd/user/voice-chat.service << 'EOF'
[Unit]
Description=Voice Chat Bridge
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/voice-chat/scripts/server.js
Environment=OPENCLAW_GATEWAY_TOKEN=your-token
Environment=OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now voice-chat
```

## Android App (ClawVoice)

The companion Android app ([ClawVoice](https://github.com/mattmanning/clawvoice)) provides:
- On-device speech-to-text via Android SpeechRecognizer
- Android TTS for response playback
- Home screen widget for quick access
- Configurable server URL in Settings

Set the server URL in the app to `http://<your-openclaw-host-ip>:8766`.

## Troubleshooting

- **502 from server**: Gateway unreachable or Chat Completions endpoint not enabled.
- **401 from gateway**: Token mismatch — verify `OPENCLAW_GATEWAY_TOKEN`.
- **Timeout**: Increase `VOICE_CHAT_TIMEOUT` for complex queries; also increase OkHttp read timeout in the Android app.
- **Can't connect from phone**: Ensure phone and server are on same network, and `VOICE_CHAT_BIND` is `0.0.0.0` (not `127.0.0.1`).
