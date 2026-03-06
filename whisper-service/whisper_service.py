#!/usr/bin/env python3
"""
Faster-Whisper sidecar service for openclaw-voice-chat.

Provides chunked audio transcription via a FastAPI HTTP interface.
Audio is accumulated per-session and transcribed incrementally.

Environment variables:
  WHISPER_MODEL        — Model size (default: "base")
  WHISPER_PORT         — Listen port (default: 8790)
  WHISPER_DEVICE       — Device: "cpu" or "cuda" (default: "cpu")
  WHISPER_COMPUTE_TYPE — Compute type (default: "int8")
"""

import base64
import logging
import os
import struct
import time
import threading
from typing import Dict

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from faster_whisper import WhisperModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
PORT = int(os.environ.get("WHISPER_PORT", "8790"))
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

SAMPLE_RATE = 16000  # Expected: 16-bit PCM mono 16 kHz
SESSION_EXPIRY_SECONDS = 60
MIN_AUDIO_SECONDS = 0.5
PARTIAL_DEBOUNCE_SECONDS = 0.5

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("whisper-service")

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


class SessionState:
    """Holds accumulated audio and timing metadata for one session."""

    def __init__(self):
        self.audio_chunks: list[bytes] = []
        self.total_bytes: int = 0
        self.last_activity: float = time.time()
        self.last_partial_time: float = 0.0
        self.lock = threading.Lock()

    def append(self, raw_pcm: bytes):
        with self.lock:
            self.audio_chunks.append(raw_pcm)
            self.total_bytes += len(raw_pcm)
            self.last_activity = time.time()

    def get_audio_array(self) -> np.ndarray:
        """Return accumulated audio as a float32 numpy array normalised to [-1, 1]."""
        with self.lock:
            if not self.audio_chunks:
                return np.array([], dtype=np.float32)
            raw = b"".join(self.audio_chunks)
        # 16-bit signed little-endian PCM
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return samples

    def duration_seconds(self) -> float:
        # 2 bytes per sample at 16 kHz
        return self.total_bytes / (2 * SAMPLE_RATE)

    def is_expired(self) -> bool:
        return (time.time() - self.last_activity) > SESSION_EXPIRY_SECONDS

    def clear(self):
        with self.lock:
            self.audio_chunks.clear()
            self.total_bytes = 0
            self.last_partial_time = 0.0


sessions: Dict[str, SessionState] = {}
sessions_lock = threading.Lock()


def get_session(session_id: str) -> SessionState:
    with sessions_lock:
        if session_id not in sessions:
            sessions[session_id] = SessionState()
        return sessions[session_id]


def remove_session(session_id: str):
    with sessions_lock:
        sessions.pop(session_id, None)


# ---------------------------------------------------------------------------
# Background reaper — removes expired sessions
# ---------------------------------------------------------------------------


def _reaper_loop():
    while True:
        time.sleep(15)
        now = time.time()
        expired = []
        with sessions_lock:
            for sid, state in sessions.items():
                if (now - state.last_activity) > SESSION_EXPIRY_SECONDS:
                    expired.append(sid)
            for sid in expired:
                del sessions[sid]
        if expired:
            logger.info("Reaped %d expired session(s): %s", len(expired), expired)


reaper_thread = threading.Thread(target=_reaper_loop, daemon=True)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Whisper Sidecar Service")
model: WhisperModel | None = None


@app.on_event("startup")
def startup():
    global model
    logger.info(
        "Loading faster-whisper model=%s device=%s compute_type=%s",
        MODEL_NAME,
        DEVICE,
        COMPUTE_TYPE,
    )
    t0 = time.time()
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Model loaded in %.2fs", time.time() - t0)
    reaper_thread.start()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ChunkRequest(BaseModel):
    session_id: str
    audio: str  # base64-encoded PCM 16-bit mono 16 kHz


class SessionRequest(BaseModel):
    session_id: str


class TranscriptResponse(BaseModel):
    text: str
    final: bool


# ---------------------------------------------------------------------------
# Transcription helper
# ---------------------------------------------------------------------------


def transcribe_audio(audio: np.ndarray) -> str:
    """Run faster-whisper on a float32 audio array. Returns text."""
    t0 = time.time()
    segments, _info = model.transcribe(
        audio,
        beam_size=1,
        language="en",
        vad_filter=True,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    elapsed = time.time() - t0
    duration = len(audio) / SAMPLE_RATE
    logger.info(
        "Transcribed %.2fs audio in %.2fs (RTF=%.2f): %s",
        duration,
        elapsed,
        elapsed / max(duration, 0.001),
        text[:120],
    )
    return text


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/transcribe/chunk", response_model=TranscriptResponse)
def transcribe_chunk(req: ChunkRequest):
    """Append audio chunk and optionally return a partial transcription."""
    raw_pcm = base64.b64decode(req.audio)
    session = get_session(req.session_id)
    session.append(raw_pcm)

    duration = session.duration_seconds()
    now = time.time()

    # Debounce: skip partial transcription if too soon or not enough audio
    if duration < MIN_AUDIO_SECONDS:
        return TranscriptResponse(text="", final=False)

    if (now - session.last_partial_time) < PARTIAL_DEBOUNCE_SECONDS:
        return TranscriptResponse(text="", final=False)

    session.last_partial_time = now
    audio = session.get_audio_array()
    text = transcribe_audio(audio)
    return TranscriptResponse(text=text, final=False)


@app.post("/transcribe/finalize", response_model=TranscriptResponse)
def transcribe_finalize(req: SessionRequest):
    """Run final transcription on accumulated audio, then clear the session."""
    session = get_session(req.session_id)

    if session.duration_seconds() < 0.01:
        remove_session(req.session_id)
        return TranscriptResponse(text="", final=True)

    audio = session.get_audio_array()
    text = transcribe_audio(audio)
    remove_session(req.session_id)
    return TranscriptResponse(text=text, final=True)


@app.post("/transcribe/cancel")
def transcribe_cancel(req: SessionRequest):
    """Discard session audio without transcribing."""
    remove_session(req.session_id)
    logger.info("Cancelled session %s", req.session_id)
    return {"status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
