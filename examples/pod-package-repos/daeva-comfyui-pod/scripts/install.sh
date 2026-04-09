#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="${PACKAGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
IMAGE="${COMFY_IMAGE:-ghcr.io/saladtechnologies/comfyui-api:comfy0.12.3-api1.17.1-torch2.8.0-cuda12.8-runtime}"
MODELS_DIR="${MODELS_DIR:-${PACKAGE_DIR}/data/models}"
INPUT_DIR="${INPUT_DIR:-${PACKAGE_DIR}/data/input}"
OUTPUT_DIR="${OUTPUT_DIR:-${PACKAGE_DIR}/data/output}"
TEMP_DIR="${TEMP_DIR:-${PACKAGE_DIR}/data/temp}"
CUSTOM_NODES_DIR="${CUSTOM_NODES_DIR:-${PACKAGE_DIR}/data/custom_nodes}"
WORKFLOW_PATH="${COMFY_WORKFLOW_PATH:-${PACKAGE_DIR}/workflows/text-to-image.json}"
source "${PACKAGE_DIR}/scripts/default-model.env"
DEFAULT_MODEL_FILENAME="${COMFY_DEFAULT_MODEL_FILENAME:-$DEFAULT_MODEL_FILENAME}"
DEFAULT_MODEL_SOURCE_URL="${COMFY_DEFAULT_MODEL_SOURCE_URL:-$DEFAULT_MODEL_SOURCE_URL}"
DEFAULT_MODEL_SHA256="${COMFY_DEFAULT_MODEL_SHA256:-$DEFAULT_MODEL_SHA256}"
DEFAULT_MODEL_SUBDIR="${COMFY_DEFAULT_MODEL_SUBDIR:-$DEFAULT_MODEL_SUBDIR}"
MODEL_TARGET_DIR="${MODELS_DIR}/${DEFAULT_MODEL_SUBDIR}"
MODEL_TARGET_PATH="${MODEL_TARGET_DIR}/${DEFAULT_MODEL_FILENAME}"

for dir in "$MODELS_DIR" "$INPUT_DIR" "$OUTPUT_DIR" "$TEMP_DIR" "$CUSTOM_NODES_DIR" "$MODEL_TARGET_DIR"; do
  mkdir -p "$dir"
done

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Missing packaged workflow: $WORKFLOW_PATH" >&2
  exit 1
fi

if [[ "${SKIP_PODMAN_STEPS:-0}" == "1" ]]; then
  echo "==> [comfyapi install] skipping image pull because SKIP_PODMAN_STEPS=1"
elif command -v podman >/dev/null 2>&1; then
  echo "==> [comfyapi install] Pulling image: $IMAGE"
  podman pull "$IMAGE"
else
  echo "==> [comfyapi install] podman not found, skipping image pull" >&2
fi

fetch_model() {
  local source_url="$1"
  local target_path="$2"
  if [[ "$source_url" == file://* ]]; then
    cp "${source_url#file://}" "$target_path"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$source_url" -o "$target_path"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target_path" "$source_url"
    return
  fi
  echo "Need curl or wget to download default model from $source_url" >&2
  exit 1
}

if [[ ! -f "$MODEL_TARGET_PATH" ]]; then
  echo "==> [comfyapi install] Installing default checkpoint: $MODEL_TARGET_PATH"
  fetch_model "$DEFAULT_MODEL_SOURCE_URL" "$MODEL_TARGET_PATH"
fi

ACTUAL_SHA256="$(sha256sum "$MODEL_TARGET_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$DEFAULT_MODEL_SHA256" ]]; then
  echo "Default model checksum mismatch for $MODEL_TARGET_PATH" >&2
  echo "Expected: $DEFAULT_MODEL_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  echo "Override COMFY_DEFAULT_MODEL_SOURCE_URL / COMFY_DEFAULT_MODEL_SHA256 to use a real checkpoint." >&2
  exit 1
fi

echo "==> [comfyapi install] Ready"
