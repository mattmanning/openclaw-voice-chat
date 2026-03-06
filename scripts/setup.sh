#!/usr/bin/env bash
#
# Setup script for voice-chat bridge + whisper sidecar.
# Run once to install dependencies and create systemd services.
#
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$SKILL_DIR/scripts"
WHISPER_DIR="$SKILL_DIR/whisper-service"

echo "=== Voice Chat Bridge Setup ==="
echo "Skill directory: $SKILL_DIR"

# --- Node.js dependencies ---
echo ""
echo "Installing Node.js dependencies..."
cd "$SKILL_DIR"
npm install --omit=dev 2>/dev/null || npm install 2>/dev/null
echo "  Done."

# --- Python venv for whisper sidecar ---
echo ""
echo "Setting up whisper sidecar Python venv..."
cd "$WHISPER_DIR"
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
pip install -q -r requirements.txt
deactivate
echo "  Done."

# --- Prompt for configuration ---
echo ""
echo "=== Configuration ==="
echo ""

read -rp "OpenClaw gateway URL [http://127.0.0.1:18789]: " GATEWAY_URL
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"

read -rp "OpenClaw gateway token: " GATEWAY_TOKEN
if [ -z "$GATEWAY_TOKEN" ]; then
  echo "ERROR: Gateway token is required."
  exit 1
fi

read -rp "Agent name [Sancho]: " AGENT_NAME
AGENT_NAME="${AGENT_NAME:-Sancho}"

read -rp "Client auth token (leave empty to disable): " AUTH_TOKEN

read -rp "Voice chat port [8766]: " VOICE_PORT
VOICE_PORT="${VOICE_PORT:-8766}"

read -rp "Whisper port [8790]: " WHISPER_PORT
WHISPER_PORT="${WHISPER_PORT:-8790}"

read -rp "Whisper model [base]: " WHISPER_MODEL
WHISPER_MODEL="${WHISPER_MODEL:-base}"

# --- Create systemd services ---
echo ""
echo "Creating systemd services..."

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# Whisper sidecar service
cat > "$SYSTEMD_DIR/whisper-sidecar.service" << EOF
[Unit]
Description=Whisper Sidecar (faster-whisper transcription)
After=network.target

[Service]
ExecStart=${WHISPER_DIR}/venv/bin/python ${WHISPER_DIR}/whisper_service.py
Environment=WHISPER_MODEL=${WHISPER_MODEL}
Environment=WHISPER_PORT=${WHISPER_PORT}
Environment=WHISPER_DEVICE=cpu
Environment=WHISPER_COMPUTE_TYPE=int8
Restart=always
RestartSec=5
WorkingDirectory=${WHISPER_DIR}

[Install]
WantedBy=default.target
EOF

# Voice chat bridge service
AUTH_LINE=""
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_LINE="Environment=VOICE_CHAT_TOKEN=${AUTH_TOKEN}"
fi

cat > "$SYSTEMD_DIR/voice-chat.service" << EOF
[Unit]
Description=Voice Chat Bridge (OpenClaw)
After=network.target whisper-sidecar.service
Wants=whisper-sidecar.service

[Service]
ExecStart=/usr/bin/node ${SCRIPTS_DIR}/server.js
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
Environment=OPENCLAW_GATEWAY_URL=${GATEWAY_URL}
Environment=VOICE_CHAT_AGENT_NAME=${AGENT_NAME}
Environment=VOICE_CHAT_PORT=${VOICE_PORT}
Environment=WHISPER_SERVICE_URL=http://localhost:${WHISPER_PORT}
${AUTH_LINE}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

echo "  Created whisper-sidecar.service"
echo "  Created voice-chat.service"

# --- Enable and start ---
systemctl --user daemon-reload
systemctl --user enable whisper-sidecar voice-chat
systemctl --user restart whisper-sidecar
echo "  Waiting for whisper model to load..."
sleep 5
systemctl --user restart voice-chat

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Services:"
echo "  Voice chat bridge:  http://0.0.0.0:${VOICE_PORT}"
echo "  Whisper sidecar:    http://localhost:${WHISPER_PORT}"
echo ""
echo "Commands:"
echo "  systemctl --user status voice-chat whisper-sidecar"
echo "  journalctl --user -u voice-chat -f"
echo "  journalctl --user -u whisper-sidecar -f"
