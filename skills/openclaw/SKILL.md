# Skill: daeva

**Use when:** The user asks to transcribe audio, generate images, run OCR/vision jobs, manage local AI pods (Whisper, ComfyUI, etc.), or interact with the local orchestrator.

---

## Overview

`daeva` is a local HTTP service that routes inference jobs to GPU-backed pods (Whisper, ComfyUI, OCR/vision, etc.). It runs on `http://127.0.0.1:8787` by default.

This skill covers:
- Checking pod/service status
- Submitting and polling jobs
- Installing pod packages from the registry
- Interacting via the MCP server (if configured)

---

## Base URL

```
ORCHESTRATOR_BASE_URL=http://127.0.0.1:8787   # default
```

Check if it's running:
```bash
curl -s http://127.0.0.1:8787/health
# → {"ok":true}
```

---

## Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness check |
| GET | `/pods` | List registered pods |
| GET | `/pods/aliases` | List installable pod aliases |
| GET | `/pods/installed` | List installed packages |
| POST | `/pods/create` | Install a pod (alias or source) |
| GET | `/status` | Full status snapshot |
| GET | `/status/scheduler` | Queue depth, running jobs |
| POST | `/jobs` | Enqueue a job |
| GET | `/jobs/:id` | Job state |
| GET | `/jobs/:id/result` | Job result |

---

## Common Tasks

### Check status
```bash
curl -s http://127.0.0.1:8787/status | jq .
```

### List pods & aliases
```bash
curl -s http://127.0.0.1:8787/pods | jq .
curl -s http://127.0.0.1:8787/pods/aliases | jq .
```

### Install a pod from registry alias
```bash
curl -s -X POST http://127.0.0.1:8787/pods/create \
  -H 'Content-Type: application/json' \
  -d '{"alias":"whisper"}' | jq .
```

### Submit a transcription job
```bash
curl -s -X POST http://127.0.0.1:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "transcribe-audio",
    "capability": "speech-to-text",
    "input": {
      "filePath": "/tmp/audio.wav",
      "contentType": "audio/wav"
    }
  }' | jq .
# Returns: {"job":{"id":"...","status":"queued",...}}
```

### Poll a job
```bash
JOB_ID="<id from above>"
curl -s "http://127.0.0.1:8787/jobs/$JOB_ID" | jq .job.status
curl -s "http://127.0.0.1:8787/jobs/$JOB_ID/result" | jq .
```

### Submit an image generation job
```bash
curl -s -X POST http://127.0.0.1:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "generate-image",
    "capability": "image-generation",
    "input": {
      "prompt": "a red fox on a snowy mountain, photorealistic",
      "width": 1024,
      "height": 1024
    }
  }' | jq .
```

---

## MCP Server (for AI clients)

The orchestrator ships an MCP stdio server exposing 8 tools:

| Tool | Description |
|------|-------------|
| `list_pods` | List registered pods |
| `list_aliases` | List installable pod aliases |
| `list_installed` | List installed packages |
| `get_status` | Full status snapshot |
| `get_scheduler` | Queue/scheduler state |
| `enqueue_job` | Submit a job |
| `get_job` | Get job state + result |
| `create_pod` | Install a pod |

### MCP client config (e.g. for Claude Desktop / OpenClaw)

```json
{
  "mcpServers": {
    "daeva": {
      "command": "node",
      "args": [
        "/path/to/daeva/dist/src/mcp-cli.js",
        "--base-url", "http://127.0.0.1:8787"
      ]
    }
  }
}
```

Or via environment variable:
```bash
ORCHESTRATOR_BASE_URL=http://127.0.0.1:8787 node dist/src/mcp-cli.js
```

---

## Starting the Orchestrator

**Quick start (foreground):**
```bash
cd ~/daeva
PORT=8787 node dist/src/cli.js
```

**Via systemd user service (if installed):**
```bash
systemctl --user start daeva
systemctl --user status daeva
journalctl --user -fu daeva
```

**Install script (server setup):**
```bash
./scripts/install-server.sh              # full setup
./scripts/install-server.sh --skip-podman   # no Podman setup
./scripts/install-server.sh --skip-service  # no systemd unit
./scripts/install-server.sh --dry-run       # see what would happen
```

---

## Capabilities & Job Types

| Capability | Common type strings | Required input keys |
|-----------|---------------------|---------------------|
| `speech-to-text` | `transcribe-audio` | `filePath` or `url` + `contentType` |
| `image-generation` | `generate-image` | `prompt` |
| `ocr` | `extract-text` | `filePath` or `url` |
| `vision` | `describe-image`, `detect-objects` | `filePath` or `url` |

---

## Troubleshooting

- **`/health` returns connection refused** → orchestrator isn't running. Start it or check `systemctl --user status daeva`.
- **Job stays `queued`** → no pod registered for that capability. Check `/pods` and ensure a pod is running.
- **`404 alias not found`** → use `/pods/aliases` to list valid aliases, or install from a direct source.
- **Podman pull fails** → ensure Podman is installed and the user has network access.

---

## Notes

- Data lives in `~/.local/share/daeva/` by default (override with `DATA_DIR` env var).
- All times are ISO 8601. Job results are ephemeral (in-memory) — not persisted across restarts.
- For GPU pods, ensure the container runtime has access to the GPU (e.g. `--device nvidia.com/gpu=all` in quadlet).
