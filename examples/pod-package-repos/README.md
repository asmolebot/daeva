# Pod Package Repos — Split Plan

This directory describes how the sample pod packages shipped with `asmo-pod-orchestrator`
should be split into separate, independently publishable repositories.

Each repo is a self-contained `asmo` pod package: a `pod-package.json` manifest, a `README.md`,
optional Dockerfile/scripts/quadlet files, and no dependency on the orchestrator source tree.

---

## Planned Repositories

### 1. `asmo-whisper-pod` — Speech-to-text (Whisper)

**Suggested repo:** `github.com/your-org/asmo-whisper-pod`  
**Based on:** `examples/whisper-pod-package/`  
**Status:** Stub — see `asmo-whisper-pod/` in this directory.

**Contents:**
```
asmo-whisper-pod/
  pod-package.json          # canonical package manifest (schemaVersion: "1")
  README.md                 # install/usage instructions
  Dockerfile                # builds docker.io/library/asmo-whisper image
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

### 2. `asmo-comfyui-pod` — Image generation (ComfyUI)

**Suggested repo:** `github.com/your-org/asmo-comfyui-pod`  
**Status:** Stub — see `asmo-comfyui-pod/` in this directory.

**Contents:**
```
asmo-comfyui-pod/
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

**Registry alias:** `comfy`  
**Capability:** `image-generation`

---

### 3. `asmo-vision-pod` — Vision / OCR (e.g. Ollama + llava, or paddleOCR)

**Suggested repo:** `github.com/your-org/asmo-vision-pod`  
**Status:** Stub — see `asmo-vision-pod/` in this directory.

**Contents:**
```
asmo-vision-pod/
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

The local registry index (`src/manifests/local-registry-index.json`) references each repo
as a `github-repo` source. When a user runs:

```bash
curl -X POST http://localhost:8787/pods/create -d '{"alias":"whisper"}'
```

The orchestrator:
1. Resolves `whisper` alias → `GithubRepoRegistrySource { repo: "your-org/asmo-whisper-pod" }`
2. Clones the repo into `.data/pod-packages/whisper/`
3. Validates `pod-package.json`
4. Runs install hooks (podman pull, dir creation, etc.)

No changes to the orchestrator source are needed when new pod packages are published.

---

## Registry Index Update (when repos go live)

Update `src/manifests/local-registry-index.json` entries to point at real repos:

```json
{
  "alias": "whisper",
  "packageName": "asmo-whisper-pod",
  "source": {
    "kind": "github-repo",
    "repo": "your-org/asmo-whisper-pod",
    "ref": "main",
    "packageManifestPath": "pod-package.json"
  }
}
```

---

## Stub Directories

See sibling directories for per-package stubs:
- [`asmo-whisper-pod/`](./asmo-whisper-pod/) — Whisper package stub
- [`asmo-comfyui-pod/`](./asmo-comfyui-pod/) — ComfyUI package stub
- [`asmo-vision-pod/`](./asmo-vision-pod/) — Vision/OCR package stub
