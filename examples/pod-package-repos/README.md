# Pod Package Repos — Split Plan

This directory describes how the sample pod packages shipped with `daeva`
should be split into separate, independently publishable repositories.

Each repo is a self-contained `asmo` pod package: a `pod-package.json` manifest, a `README.md`,
optional Dockerfile/scripts/quadlet files, and no dependency on the orchestrator source tree.

---

## Planned Repositories

### 1. `daeva-whisper-pod` — Speech-to-text (Whisper)

**Suggested repo:** `github.com/your-org/daeva-whisper-pod`  
**Based on:** `examples/whisper-pod-package/`  
**Status:** Stub — see `daeva-whisper-pod/` in this directory.

**Contents:**
```
daeva-whisper-pod/
  pod-package.json          # canonical package manifest (schemaVersion: "1")
  README.md                 # install/usage instructions
  Dockerfile                # builds docker.io/library/daeva-whisper image
  scripts/
    install.sh              # podman pull + directory setup
    start.sh                # podman run (or quadlet start)
    stop.sh                 # podman stop/rm
  deploy/
    whisper.container       # Podman quadlet unit
```

**Registry alias:** `whisper`  
**Capability:** `speech-to-text`

---

### 2. `daeva-comfyui-pod` — Image generation (ComfyUI)

**Suggested repo:** `github.com/your-org/daeva-comfyui-pod`  
**Status:** Stub — see `daeva-comfyui-pod/` in this directory.

**Contents:**
```
daeva-comfyui-pod/
  pod-package.json
  README.md
  Dockerfile                # or reference to official ComfyUI image
  scripts/
    install.sh
    start.sh
    stop.sh
  deploy/
    comfyui.container       # quadlet unit
```

**Registry alias:** `comfyapi`  
**Compatibility alias:** `comfy`  
**Capability:** `image-generation`

---

### 3. `daeva-vision-pod` — Vision / OCR (e.g. Ollama + llava, or paddleOCR)

**Suggested repo:** `github.com/your-org/daeva-vision-pod`  
**Status:** Stub — see `daeva-vision-pod/` in this directory.

**Contents:**
```
daeva-vision-pod/
  pod-package.json
  README.md
  scripts/
    install.sh
    start.sh
    stop.sh
  deploy/
    vision.container
```

**Registry alias:** `vision`  
**Capabilities:** `ocr`, `vision`

---

## How Split Works with the Registry

The local registry index (`src/manifests/local-registry-index.json`) references each repo.
When a user runs:

```bash
curl -X POST http://localhost:8787/pods/create -d '{"alias":"whisper"}'
```

The orchestrator:
1. Resolves an alias like `comfyapi` to its package source
2. Materializes the package into managed storage
3. Validates `pod-package.json`
4. Runs install hooks (dir creation, workflow checks, image pull, default artifact validation, etc.)

No changes to the orchestrator source are needed when new pod packages are published.

---

## Registry Index Update (when repos go live)

Update `src/manifests/local-registry-index.json` entries to point at real repos:

```json
{
  "alias": "whisper",
  "packageName": "daeva-whisper-pod",
  "source": {
    "kind": "github-repo",
    "repo": "your-org/daeva-whisper-pod",
    "ref": "main",
    "packageManifestPath": "pod-package.json"
  }
}
```

---

## Stub Directories

See sibling directories for per-package stubs:
- [`daeva-whisper-pod/`](./daeva-whisper-pod/) — Whisper package stub
- [`daeva-comfyui-pod/`](./daeva-comfyui-pod/) — canonical Comfy package example
- [`daeva-vision-pod/`](./daeva-vision-pod/) — Vision/OCR package stub
