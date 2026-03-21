# asmo-whisper-pod

> **Pod package stub** — to be published as a separate repo.

Portable pod package for running [Whisper](https://github.com/openai/whisper) (or
`faster-whisper`) as a local speech-to-text HTTP service managed by `asmo-pod-orchestrator`.

## Install via orchestrator

```bash
curl -X POST http://localhost:8787/pods/create \
  -H 'Content-Type: application/json' \
  -d '{"alias":"whisper"}'
```

## Manual install

```bash
git clone https://github.com/your-org/asmo-whisper-pod
cd asmo-whisper-pod
./scripts/install.sh
```

## Requirements

- Podman (or Docker)
- NVIDIA GPU + CUDA drivers (for GPU acceleration; CPU fallback supported)
- ~4–12 GB disk for model weights

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WHISPER_MODEL` | `large-v3-turbo` | Model to load |
| `WHISPER_DEVICE` | `cuda` | `cuda` or `cpu` |
| `WHISPER_COMPUTE_TYPE` | `float16` | Quantization type |
| `WHISPER_PORT` | `8001` | Service port |

## Service port

`8001` — `POST /transcribe`, `GET /health`

## Quadlet install (Podman)

```bash
cp deploy/whisper.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start whisper
```

## See also

- [asmo-pod-orchestrator](https://github.com/your-org/asmo-pod-orchestrator)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
