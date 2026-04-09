#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="${PACKAGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONTAINER_NAME="${COMFY_CONTAINER_NAME:-comfyapi}"
IMAGE="${COMFY_IMAGE:-ghcr.io/saladtechnologies/comfyui-api:comfy0.12.3-api1.17.1-torch2.8.0-cuda12.8-runtime}"
PORT="${COMFY_PORT:-8188}"
MODELS_DIR="${MODELS_DIR:-${PACKAGE_DIR}/data/models}"
INPUT_DIR="${INPUT_DIR:-${PACKAGE_DIR}/data/input}"
OUTPUT_DIR="${OUTPUT_DIR:-${PACKAGE_DIR}/data/output}"
TEMP_DIR="${TEMP_DIR:-${PACKAGE_DIR}/data/temp}"
CUSTOM_NODES_DIR="${CUSTOM_NODES_DIR:-${PACKAGE_DIR}/data/custom_nodes}"
WORKFLOWS_DIR="${COMFY_WORKFLOWS_DIR:-${PACKAGE_DIR}/workflows}"
HEALTH_URL="${COMFY_HEALTH_URL:-http://127.0.0.1:${PORT}/system_stats}"

for dir in "$MODELS_DIR" "$INPUT_DIR" "$OUTPUT_DIR" "$TEMP_DIR" "$CUSTOM_NODES_DIR"; do
  mkdir -p "$dir"
done

podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
podman run -d   --name "$CONTAINER_NAME"   --replace   --device nvidia.com/gpu=all   -p "$PORT:$PORT"   -v "$MODELS_DIR:/opt/ComfyUI/models"   -v "$INPUT_DIR:/opt/ComfyUI/input"   -v "$OUTPUT_DIR:/opt/ComfyUI/output"   -v "$TEMP_DIR:/opt/ComfyUI/temp"   -v "$CUSTOM_NODES_DIR:/opt/ComfyUI/custom_nodes"   -v "$WORKFLOWS_DIR:/opt/ComfyUI/user/default/workflows:ro"   "$IMAGE"

for attempt in $(seq 1 60); do
  if command -v curl >/dev/null 2>&1 && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "==> [comfyapi start] Ready: $HEALTH_URL"
    exit 0
  fi
  sleep 1
done

echo "Comfy API did not become ready at $HEALTH_URL" >&2
exit 1
