# Daeva — Local GPU Pod Orchestrator

Daeva routes AI inference jobs (transcription, image generation, OCR/vision) to GPU-backed local pods via a REST/MCP API.

## When to use this skill

Use daeva tools when the user asks to:
- Transcribe audio (Whisper)
- Generate images (ComfyUI or similar)
- Run OCR or vision/image analysis
- Check status of local AI pods
- Install or manage pod packages

## Base URL

Default: `http://127.0.0.1:8787`

Check health: `curl -s http://127.0.0.1:8787/health` → `{"ok":true}`

## Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness check |
| GET | `/pods` | List registered pods |
| GET | `/pods/aliases` | List installable pod aliases |
| POST | `/pods/create` | Install a pod |
| GET | `/status` | Full status snapshot |
| POST | `/jobs` | Enqueue a job |
| GET | `/jobs/:id` | Job state |
| GET | `/jobs/:id/result` | Job result |

## Job Submission

```bash
# Transcribe audio
curl -s -X POST http://127.0.0.1:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"transcribe-audio","capability":"speech-to-text","input":{"filePath":"/tmp/audio.wav","contentType":"audio/wav"}}'

# Generate image
curl -s -X POST http://127.0.0.1:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"generate-image","capability":"image-generation","input":{"prompt":"a red fox on a snowy mountain"}}'
```

## Capabilities

| Capability | Job type | Required input |
|-----------|----------|----------------|
| `speech-to-text` | `transcribe-audio` | `filePath` or `url` + `contentType` |
| `image-generation` | `generate-image` | `prompt` |
| `ocr` | `extract-text` | `filePath` or `url` |
| `vision` | `describe-image` | `filePath` or `url` |

## MCP Server

Daeva ships an MCP stdio server. Config for Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "daeva": {
      "command": "node",
      "args": ["dist/src/mcp-cli.js", "--base-url", "http://127.0.0.1:8787"]
    }
  }
}
```

## Starting the Service

```bash
# Foreground
PORT=8787 node dist/src/cli.js

# systemd user service (after install)
systemctl --user start daeva
systemctl --user status daeva
```

## Troubleshooting

- **Connection refused on `/health`** → service not running; start it or check `systemctl --user status daeva`
- **Job stays `queued`** → no pod registered for that capability; check `/pods`
- **`404 alias not found`** → check `/pods/aliases` for valid aliases
