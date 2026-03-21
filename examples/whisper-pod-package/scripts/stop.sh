#!/usr/bin/env bash
# stop.sh — Stop the asmo-whisper Podman container.
#
# Graceful stop; does not remove the container so it can be restarted quickly.
set -euo pipefail

CONTAINER_NAME="${WHISPER_CONTAINER_NAME:-asmo-whisper}"

if podman container exists "${CONTAINER_NAME}" 2>/dev/null; then
  echo "==> [asmo-whisper stop] Stopping container: ${CONTAINER_NAME}"
  podman stop "${CONTAINER_NAME}"
  echo "==> [asmo-whisper stop] Done."
else
  echo "==> [asmo-whisper stop] Container not found: ${CONTAINER_NAME} (already stopped?)"
fi
