#!/usr/bin/env bash
# install.sh — One-time setup for the asmo-whisper pod.
#
# Called during package install (not on every start).  Pulls the container
# image and creates required host directories.
#
# Template variables such as ${DATA_DIR} and ${HOME} are expanded by the
# orchestrator before this script is executed.  The raw defaults below are
# used when the script is run directly by a human.
set -euo pipefail

IMAGE="${WHISPER_IMAGE:-docker.io/library/asmo-whisper:latest}"
MODELS_DIR="${WHISPER_MODELS_DIR:-${HOME}/ai/services/whisper/models}"

echo "==> [asmo-whisper install] Pulling image: ${IMAGE}"
if command -v podman &>/dev/null; then
  podman pull "${IMAGE}"
else
  echo "    podman not found — skipping image pull. Pull manually: podman pull ${IMAGE}"
fi

echo "==> [asmo-whisper install] Creating models directory: ${MODELS_DIR}"
mkdir -p "${MODELS_DIR}"

echo "==> [asmo-whisper install] Done."
