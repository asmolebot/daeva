# daeva-vision-pod

> **Pod package stub** — to be published as a separate repo.

Portable pod package for local vision and OCR inference managed by `daeva`.
Backed by [Ollama](https://github.com/ollama/ollama) with a vision-capable model (e.g. `llava`)
or a dedicated OCR engine (e.g. PaddleOCR).

## Install via orchestrator

```bash
curl -X POST http://localhost:8787/pods/create \
  -H 'Content-Type: application/json' \
  -d '{"alias":"vision"}'
```

## Requirements

- Podman (or Docker)
- NVIDIA GPU recommended (CPU fallback supported for OCR)
- ~5–20 GB disk for model weights

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `VISION_PORT` | `8002` | Service port |
| `VISION_MODEL` | `llava` | Ollama model name |
| `VISION_MODELS_DIR` | `~/ai/services/vision/models` | Model directory |

## Service port

`8002` — `POST /describe`, `POST /ocr`, `GET /health`

## Capabilities

- `vision` — image description, visual Q&A
- `ocr` — text extraction from images/documents

## Quadlet install

```bash
cp deploy/vision.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start daeva-vision
```

## See also

- [daeva](https://github.com/your-org/daeva)
- [Ollama](https://github.com/ollama/ollama)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
