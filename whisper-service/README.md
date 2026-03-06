# Whisper Sidecar Service

A faster-whisper based transcription service that runs alongside the openclaw-voice-chat server. It accumulates audio chunks per session and provides partial and final transcriptions.

## Setup

```bash
cd whisper-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python whisper_service.py
```

Or with uvicorn directly:

```bash
uvicorn whisper_service:app --host 0.0.0.0 --port 8790
```

## Configuration

| Environment Variable   | Default | Description                    |
|------------------------|---------|--------------------------------|
| `WHISPER_MODEL`        | `base`  | faster-whisper model size      |
| `WHISPER_PORT`         | `8790`  | Listen port                    |
| `WHISPER_DEVICE`       | `cpu`   | `cpu` or `cuda`                |
| `WHISPER_COMPUTE_TYPE` | `int8`  | Compute type for the model     |

## Endpoints

- `POST /transcribe/chunk` — Append audio, get partial transcript
- `POST /transcribe/finalize` — Get final transcript, clear session
- `POST /transcribe/cancel` — Discard session audio
- `GET /health` — Health check

Audio format: base64-encoded PCM 16-bit signed little-endian mono 16 kHz.
