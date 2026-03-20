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
- [ ] Support create from uploaded archive
- [x] Support create from named registry alias
  - Added `src/create-flow.ts` with `planCreateFromAlias()` so alias resolution + next-step messaging lives in one place and can later branch into real materialization handlers.
  - Alias-based creates now either materialize/install (`local-file`, `github-repo`) or return a delegated plan (`registry-index`).
- [x] Unpack/clone package into managed local storage
  - `POST /pods/create` now copies local package directories into `.data/pod-packages/<alias>` and does a first-pass `git clone` + copy for GitHub/direct Git sources.
  - Materialization stays intentionally narrow: clone/package copy only, no archive extraction yet.
- [x] Validate package manifest before install
  - Local and Git materialization now read `pod-package.json` (or the source-provided manifest path) and validate it with the existing `podPackageManifestSchema` via `parsePodPackageManifest()` before persisting install metadata.
- [x] Persist installed pod metadata
  - Installed package metadata continues to live in `.data/installed-packages.json` with the same schema/store shape for local and Git-backed installs.

### D. Runtime/install improvements
- [ ] Split install/start/stop/build semantics more cleanly in manifests
- [ ] Add real install hooks for Podman-based pods
- [ ] Improve host path/volume templating
- [ ] Add support for optional service/quadlet metadata in package spec
- [ ] Add richer runtime state detection from local Podman

### E. Better job contracts
- [ ] Define first-class file input contract (path/upload/contentType/filename)
- [ ] Define richer normalized result contract
- [ ] Add explicit job validation per capability
- [ ] Add better error payloads and job failure reasons

### F. Richer status
- [ ] Add endpoint for active runtime/container status
- [x] Add endpoint for installed packages and registry sources
  - Added `GET /pods/installed` and also linked installed metadata from `POST /pods/create` responses for successfully materialized local packages.
- [ ] Add endpoint for scheduler/exclusivity state
- [ ] Add endpoint for recent job history summary

### G. MCP/client follow-up
- [ ] Define thin MCP server surface over the HTTP API
- [ ] Define client skill shape for OpenClaw
- [ ] Add install script for server host setup (with flags to skip Podman/service setup)
- [ ] Split sample pod packages into separate reusable repos

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
