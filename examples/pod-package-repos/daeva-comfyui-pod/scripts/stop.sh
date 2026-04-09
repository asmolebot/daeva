#!/usr/bin/env bash
set -euo pipefail
CONTAINER_NAME="${COMFY_CONTAINER_NAME:-comfyapi}"
if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
  podman stop "$CONTAINER_NAME"
else
  echo "==> [comfyapi stop] Container not found: $CONTAINER_NAME"
fi
