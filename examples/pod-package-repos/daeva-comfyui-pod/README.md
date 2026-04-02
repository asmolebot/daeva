# daeva-comfyui-pod

> **Pod package stub** — to be published as a separate repo.

Portable pod package for running [ComfyUI](https://github.com/comfyanonymous/ComfyUI) as a
local image-generation HTTP service managed by `daeva`.

## Install via orchestrator

```bash
curl -X POST http://localhost:8787/pods/create \
  -H 'Content-Type: application/json' \
  -d '{"alias":"comfy"}'
```

## Requirements

- Podman (or Docker)
- NVIDIA GPU + CUDA drivers
- ~10–50 GB disk (depends on models)

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMFY_PORT` | `8188` | Service port |
| `COMFY_MODELS_DIR` | `~/ai/services/comfy/models` | Model weights directory |
| `COMFY_OUTPUT_DIR` | `~/ai/services/comfy/output` | Generated image output |

## Service port

`8188` — ComfyUI native API (`POST /prompt`, `GET /history/{id}`, `GET /system_stats`)

## Quadlet install

```bash
cp deploy/comfyui.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start comfyui
```

## See also

- [daeva](https://github.com/your-org/daeva)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
