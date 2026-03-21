#!/usr/bin/env bash
# start.sh — Start the asmo-whisper Podman container.
#
# Idempotent: re-uses an existing stopped container or creates a new one.
# Template variables (${HOME}, ${WHISPER_MODELS_DIR}, etc.) are expanded by
# the orchestrator before execution.
set -euo pipefail

CONTAINER_NAME="${WHISPER_CONTAINER_NAME:-asmo-whisper}"
IMAGE="${WHISPER_IMAGE:-docker.io/library/asmo-whisper:latest}"
PORT="${WHISPER_PORT:-8001}"
MODELS_DIR="${WHISPER_MODELS_DIR:-${HOME}/ai/services/whisper/models}"
WHISPER_MODEL="${WHISPER_MODEL:-large-v3-turbo}"
WHISPER_DEVICE="${WHISPER_DEVICE:-cuda}"
WHISPER_COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-float16}"

if podman container exists "${CONTAINER_NAME}" 2>/dev/null; then
  echo "==> [asmo-whisper start] Restarting existing container: ${CONTAINER_NAME}"
  podman start "${CONTAINER_NAME}"
else
  echo "==> [asmo-whisper start] Creating container: ${CONTAINER_NAME}"
  podman run -d \
    --name "${CONTAINER_NAME}" \
    --replace \
    --device nvidia.com/gpu=all \
    -p "${PORT}:${PORT}" \
    -e "WHISPER_MODEL=${WHISPER_MODEL}" \
    -e "WHISPER_COMPUTE_TYPE=${WHISPER_COMPUTE_TYPE}" \
    -e "WHISPER_DEVICE=${WHISPER_DEVICE}" \
    -v "${MODELS_DIR}:/models" \
    "${IMAGE}"
fi

echo "==> [asmo-whisper start] Container started."
