# Phase 3 — Portable Pod Packages, Registry, and Client Layer

This file is the working queue for the next major phase of `asmo-pod-orchestrator`.

## Goals

- Move from hardcoded built-in pod manifests to **portable pod packages**.
- Support creating/installing pods from:
  - local archive upload (`.zip`, `.tar.gz`, etc.)
  - Git repository URL
  - named registry alias (e.g. `vision`, `whisper`, `comfy`)
- Make pod definitions reproducible, shareable, and community-friendly.
- Improve runtime/manifests, file job contracts, and status reporting.
- Prepare for a thin MCP wrapper and a client skill.

## Package concept (target)

A pod package should be a reusable repo/archive that contains, at minimum:

- `pod-package.json` (canonical manifest)
- `README.md`
- optional `Dockerfile`
- optional build/install scripts
- optional runtime/startup scripts
- optional quadlet/systemd templates
- optional scaffolding instructions for local folders/volumes/models

The package should describe:
- pod id / nickname / description
- capabilities
- runtime endpoints
- startup/shutdown/install behavior
- required local directories/volumes
- whether it wants service install / quadlet / user systemd
- source metadata

## Task list

### A. Pod package spec
- [x] Define `pod-package` directory/file specification
  - Added canonical package layout guidance in `README.md` and a concrete example under `examples/whisper-pod-package/`.
  - Minimum required files are now `pod-package.json` + `README.md`; install/service artifacts are optional but modeled.
- [x] Choose canonical manifest format (`pod.yaml` vs JSON) and versioning strategy
  - Chosen format: `pod-package.json`.
  - Versioning split: outer `schemaVersion` for package contract, inner `pod.manifestVersion` for runnable manifest contract.
- [x] Add schema validation for pod packages/manifests
  - Added `podManifestSchema` and `podPackageManifestSchema` in `src/schemas.ts`.
  - `src/manifest-loader.ts` now exports both `parseManifest()` and `parsePodPackageManifest()`.
  - Added schema tests covering valid standalone manifests, valid package manifests, and malformed package rejection.
- [x] Document package layout with examples
  - README now includes package rationale, layout tree, versioning notes, and a sample manifest shape.
  - Added example files for a Whisper portable package to make the spec tangible.

### B. Registry model
- [x] Add registry source model (local file, GitHub repo, registry index)
  - Added a typed `RegistrySource` union in `src/types.ts` and Zod validation in `src/schemas.ts` / `src/manifest-loader.ts`.
  - Supported source kinds are now `local-file`, `github-repo`, and `registry-index`.
- [x] Define named alias resolution (`vision` -> repo/package source)
  - `PodRegistry` now tracks alias entries and registry indexes, with `registerAlias()`, `listAliases()`, and `resolveAlias()` helpers.
  - Default bootstrapped aliases come from the local sample index, so `vision`, `whisper`, and `comfy` now resolve through the registry layer.
- [x] Add a simple registry index format
  - Added canonical `pod-registry-index` schema/versioning with `schemaVersion: "1"`, `indexType: "pod-registry-index"`, and `entries[]`.
  - Each entry keeps scope tight: alias, package identity, optional pod id/capabilities/tags, and a registry source descriptor.
- [x] Add first local sample index for built-in/community pods
  - Added `src/manifests/local-registry-index.json` with one local package example (`whisper`), one direct GitHub repo example (`comfy`), and one delegated registry-index alias (`vision`).
  - Added tests covering source parsing, index parsing, and alias resolution behavior.

### C. Create/install flow
- [x] Add `POST /pods/create` route
  - Added a narrow planning endpoint in `src/server.ts` that validates `{ alias }`, resolves it through `PodRegistry`, and returns a structured create plan instead of pretending install exists.
  - Added companion `GET /pods/aliases` route so clients can discover valid aliases before calling create.
- [x] Support create from Git URL
  - `POST /pods/create` now accepts either a registry alias or a direct `{ source }` payload.
  - Added first-pass `git-repo` support for arbitrary Git URLs and activated install/materialization for existing `github-repo` aliases.
- [x] Support create from uploaded archive
  - Added first-pass direct `uploaded-archive` support on `POST /pods/create` using JSON/base64 input, temp extraction, manifest validation, and the existing installed-package persistence flow.
  - Added first-pass hardening: reject absolute/traversal archive entries, reject extracted symlinks, and enforce clear compressed/extracted entry limits.
  - Scope stays intentionally narrow: `.tar`, `.tar.gz`, `.tgz`, and `.zip` extraction only; no multipart/streaming upload path yet.
- [x] Support create from named registry alias
  - Added `src/create-flow.ts` with `planCreateFromAlias()` so alias resolution + next-step messaging lives in one place and can later branch into real materialization handlers.
  - Alias-based creates now either materialize/install (`local-file`, `github-repo`) or return a delegated plan (`registry-index`).
- [x] Unpack/clone package into managed local storage
  - `POST /pods/create` now copies local package directories into `.data/pod-packages/<alias>` and does a first-pass `git clone` + copy for GitHub/direct Git sources.
  - Materialization stays intentionally narrow: clone/package copy only, no archive extraction yet.
- [x] Validate package manifest before install
  - Local and Git materialization now read `pod-package.json` (or the source-provided manifest path) and validate it with the existing `podPackageManifestSchema` via `parsePodPackageManifest()` before persisting install metadata.
- [x] Persist installed pod metadata
  - Installed package metadata continues to live in `.data/installed-packages.json` with the same schema/store shape for local, Git-backed, and uploaded-archive installs.

### D. Runtime/install improvements
- [x] Split install/start/stop/build semantics more cleanly in manifests
  - Added `install` and `build` as distinct optional lifecycle phases alongside existing `startup`/`shutdown` on `PodManifest`.
  - Each phase is documented with its own JSDoc: install = one-time setup (pull/config); build = image build; startup = bring pod up; shutdown = graceful stop.
  - `PodController.runLifecycleCommand()` now handles all four phases.
- [x] Add real install hooks for Podman-based pods
  - New `src/install-hooks.ts` with `runInstallHooks()` and `describeInstallHooks()`.
  - Runs `podman pull` for `prebuilt-image` strategy; `podman build` for `dockerfile` strategy.
  - Creates `createIfMissing` host directories with proper template expansion.
  - Executes `pod.install.command` if defined (hard error on failure, unlike Podman steps which are best-effort).
  - `create-flow.ts` captures hook descriptions (`installHookSteps`) in `MaterializedPodCreatePlan` and accepts `runInstallHooks` / `installHookOptions` flags.
  - Updated example whisper scripts from placeholder `echo` stubs to real Podman commands with env-var fallbacks.
- [x] Improve host path/volume templating
  - New `src/path-template.ts` with `applyTemplate()`, `applyTemplateToCommand()`, `applyTemplateToEnv()`, `applyTemplateToPath()`, and `buildContext()`.
  - Supports `${VAR}` and `{{VAR}}` syntax; unknown variables left unchanged.
  - Built-in variables: `HOME`, `USER`, `PACKAGE_DIR`, `DATA_DIR` (auto-derived), `POD_ID`.
  - `PodController` applies template substitution to all lifecycle commands before execution.
  - `install-hooks.ts` applies templates to all directory paths and commands.
  - Example `pod-package.json` updated to use `${HOME}` and `${PACKAGE_DIR}` in directory paths and commands.
- [x] Add support for optional service/quadlet metadata in package spec
  - `service` block in `PodPackageManifest` (and schema) expanded with a `quadlet` sub-object (image, publishPort, volume, environment, device, network, label, containerName, exec) and a `systemd` sub-object (after, wantedBy, restart, timeoutStartSec).
  - All new fields optional; schema is backward compatible with existing package manifests.
  - Example `pod-package.json` now includes a fully populated `service.quadlet` + `service.systemd` section.
  - Updated `deploy/whisper.container` quadlet file with complete [Container]/[Service]/[Install] sections.
- [x] Add richer runtime state detection from local Podman
  - `/status` and `/status/runtime` now attempt live Podman-backed inspection (`podman ps -a --format json`) for declared manifest container names, exposing observed name/image/state/status/ports with graceful fallback when Podman is absent or a container is missing.

### E. Better job contracts
- [x] Define first-class file input contract (path/upload/contentType/filename)
  - Added `JobRequest.files[]` as the canonical attachment surface with `source: "path" | "upload"`, `field`, `filename`, `contentType`, `sizeBytes`, and per-file metadata.
  - Kept it coherent for both same-host callers (`path`) and future remote clients (`uploadBase64`).
- [x] Define richer normalized result contract
  - Completed/failed jobs now store a normalized `result` envelope with `status`, selected pod/runtime info, resolved request contract summary, and structured output/error payloads.
  - Normalized outputs are now capability-shaped: `speech-to-text` -> `transcript`, `ocr`/`vision` -> `text` + `detections`, `image-generation` -> `generatedImages`, while keeping `raw` payload access.
- [x] Add explicit job validation per capability
  - Added early validation before queueing: prompt required for image generation; file-or-URL style input required for speech-to-text / OCR / vision jobs.
  - Tightened request/source schemas further with safer package-relative path constraints plus bounded file metadata/attachment counts.
- [x] Add better error payloads and job failure reasons
  - Added typed app/job errors with `code`, `type`, `details`, and `retriable`; failed jobs now retain structured failure reasons instead of a bare string.

### F. Richer status
- [x] Add endpoint for active runtime/container status
  - Added `GET /status/runtime` plus aggregate `GET /status` snapshot output.
  - Runtime status now exposes orchestrator-tracked lifecycle state, runtime URLs, last start/stop timestamps, and best-effort manifest-derived container name hints.
  - Kept scope intentionally honest: this is not live Podman inspection yet.
- [x] Add endpoint for installed packages and registry sources
  - Added `GET /status/packages` to complement `GET /pods/installed` with registry alias/index visibility and source-kind summaries.
  - `GET /pods/installed` remains the narrow install-store view; `/status/packages` is the broader observability surface.
- [x] Add endpoint for scheduler/exclusivity state
  - Added `GET /status/scheduler` with queue depth, processing flag, exclusivity groups, running pod ids, busy pod ids, and active job ids.
- [x] Add endpoint for recent job history summary
  - Added `GET /status/jobs/recent?limit=N` and included recent job summary in aggregate `GET /status`.
  - Job history is intentionally in-memory/ephemeral for now; this is a visibility surface, not a durable audit log.

### G. MCP/client follow-up
- [x] Define thin MCP server surface over the HTTP API
  - Added `src/mcp-server.ts` with a stdio JSON-RPC 2.0 MCP server (no external deps).
  - Exposes 8 tools: `list_pods`, `list_aliases`, `list_installed`, `get_status`, `get_scheduler`,
    `enqueue_job`, `get_job`, `create_pod`. All proxy to the orchestrator HTTP API.
  - Added `src/mcp-cli.ts` entry point; registered `asmo-pod-orchestrator-mcp` bin in `package.json`.
  - Launch: `node dist/src/mcp-cli.js [--base-url http://127.0.0.1:8787]`
- [x] Define client skill shape for OpenClaw
  - Added `~/asmo/skills/asmo-pod-orchestrator/SKILL.md` with endpoint reference, curl examples,
    job type/capability table, MCP client config snippet, and troubleshooting guidance.
- [x] Add install script for server host setup (with flags to skip Podman/service setup)
  - Added `scripts/install-server.sh` (chmod +x).
  - Flags: `--skip-podman`, `--skip-service`, `--skip-node-check`, `--dry-run`, `--port`, `--data-dir`,
    `--install-dir`, `--user`.
  - Installs from source tree or npm global; writes `.env`; creates systemd user service unit.
- [x] Split sample pod packages into separate reusable repos
  - Added `examples/pod-package-repos/` with a plan README and stubs for three packages:
    - `asmo-whisper-pod/` — speech-to-text (Whisper/faster-whisper)
    - `asmo-comfyui-pod/` — image generation (ComfyUI)
    - `asmo-vision-pod/` — vision + OCR (Ollama/llava or PaddleOCR)
  - Each stub has a `pod-package.json` + `README.md` ready to become an independent repo.
  - Parent `README.md` documents how the registry index should be updated when repos go live.

## Suggested working order

1. Pod package spec + schema
2. Registry index + alias resolution
3. `POST /pods/create` for Git URL
4. Archive upload path
5. Installed package persistence + status endpoints
6. MCP wrapper/client skill

## Notes

- Check off completed work directly in this file.
- Add short notes under tasks when implementation details matter.
- Heartbeat should summarize newly checked boxes and queue the next contained chunk to a coding subagent.
