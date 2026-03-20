# asmo-pod-orchestrator

A first-pass TypeScript/Node.js package for locally orchestrating GPU-backed "pods" (containerized or service-backed workers) behind a small HTTP API.

Current focus:
- Fastify REST server
- in-memory queue + scheduler
- pod registry + packaged manifests
- first-class built-ins for ComfyUI/comfyapi, Whisper, and OCR/Vision
- start/stop/switch behavior for pods that contend for the same GPU slot
- Phase 3 package spec groundwork for portable pod packages
- registry source modeling + local alias/index groundwork for future install flows

This is intentionally not a giant orchestration cathedral. It's the practical first draft: coherent, testable, and easy to extend.

## Why this exists

On a single host with limited GPU resources, multiple local AI services often fight over the same device memory. This package gives you one place to:
- register known pod backends
- submit jobs as JSON
- route each job to a capable pod
- stop/switch pods when exclusivity rules require it
- track async job state/results over HTTP

## Architecture

Core pieces:
- **`PodRegistry`**: stores pod manifests and exposes searchable metadata/capabilities
- **`PodController`**: tracks runtime state and enforces exclusivity groups (ex: `gpu-0`)
- **`SchedulerRouter`**: chooses the best pod for a job and ensures the pod is available
- **`JobManager`**: simple in-memory FIFO queue with async status/result tracking
- **`HttpPodAdapter`**: stubbed execution adapter that returns a normalized result shape; easy place to swap in real service calls/polling
- **Fastify API**: lightweight REST interface for pods, jobs, and future package upload scaffolding
- **Zod schemas**: validation for both standalone pod manifests and portable `pod-package.json` bundles

### Runtime model

Each pod manifest can define:
- metadata and capabilities
- source/homepage/readme links
- HTTP runtime info (`baseUrl`, `submitPath`, etc.)
- startup/shutdown commands
- an `exclusivityGroup` to express GPU contention

If two pods share the same exclusivity group, the controller stops the currently running idle pod before starting the next one.

## Built-in pods

Included manifests live in `src/manifests/builtin.ts`:
- `comfyapi`
- `whisper`
- `ocr-vision`

These are sample first-party definitions. They include source metadata, runtime endpoints, and simulated start/stop delays for local testing.

## Install

```bash
npm install
```

## Run in dev

```bash
npm run dev
```

Default server:
- host: `0.0.0.0`
- port: `8787`

Override with:

```bash
HOST=127.0.0.1 PORT=8787 npm run dev
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## CLI

After build:

```bash
npm start
# or
node dist/cli.js
```

## REST API

### `GET /health`
Simple liveness probe.

### `GET /pods`
List registered pods plus runtime state.

Example response shape:

```json
{
  "pods": [
    {
      "manifest": {
        "id": "comfyapi",
        "nickname": "Comfy",
        "capabilities": ["image-generation", "vision"]
      },
      "status": "running"
    }
  ]
}
```

### `POST /pods/register`
Register a new pod manifest.

Example:

```json
{
  "id": "vision-lora-worker",
  "nickname": "Vision Lora Worker",
  "description": "Example external pod",
  "manifestVersion": "1",
  "capabilities": ["vision"],
  "source": {
    "homepage": "https://example.com/worker",
    "readme": "https://example.com/worker/readme",
    "repository": "https://github.com/example/worker"
  },
  "runtime": {
    "kind": "http-service",
    "baseUrl": "http://127.0.0.1:9200",
    "submitPath": "/jobs",
    "method": "POST"
  },
  "exclusivityGroup": "gpu-1"
}
```

### `GET /pods/packages/upload-spec`
Scaffolded endpoint describing the future remote package upload flow.

### `POST /jobs`
Submit an async job.

Example request:

```json
{
  "type": "generate-image",
  "input": {
    "prompt": "A tiny infernal familiar operating a GPU rack"
  }
}
```

Optional fields:
- `capability`: explicitly force capability selection
- `preferredPodId`: pin a specific pod
- `metadata`: attach opaque caller metadata

Response:

```json
{
  "job": {
    "id": "job_xxx",
    "status": "queued"
  },
  "links": {
    "self": "/jobs/job_xxx",
    "result": "/jobs/job_xxx/result"
  }
}
```

### `GET /jobs`
List jobs in memory.

### `GET /jobs/:jobId`
Get a single job and its current state:
- `queued`
- `running`
- `completed`
- `failed`

### `GET /jobs/:jobId/result`
Return the result payload once complete, otherwise `null`.

## Portable pod package spec

Phase 3 now defines a canonical **JSON** package manifest: `pod-package.json`.

Why JSON right now:
- the project is already TypeScript + Zod-first
- package ingestion needs deterministic validation before install flows exist
- JSON keeps examples, tests, and future API upload payloads simple

YAML can still be supported later as an import/conversion layer, but `pod-package.json` is the canonical on-disk format for package validation and versioning.

### Versioning strategy

There are two explicit version markers:

- `schemaVersion`: version of the outer portable package contract (`pod-package.json`)
- `pod.manifestVersion`: version of the inner runnable pod manifest contract

Current values:
- `schemaVersion: "1"`
- `pod.manifestVersion: "1"`

Rule of thumb:
- breaking schema/layout changes => bump `schemaVersion`
- breaking runtime manifest changes => bump `pod.manifestVersion`
- normal package release/version updates => bump package `version`, not the schema version

### Required package files

Minimum portable package layout:
- `pod-package.json` — canonical package manifest
- `README.md` — human-facing setup/usage notes

### Optional package files

Optional but explicitly modeled in the manifest:
- `Dockerfile`
- `deploy/*.container` or other systemd/quadlet units
- `scripts/install.sh`
- `scripts/start.sh`
- `scripts/stop.sh`
- local `data/` scaffolding directories for models, inputs, outputs, cache, etc.

### Canonical example layout

```text
examples/whisper-pod-package/
├── pod-package.json
├── README.md
├── Dockerfile
├── deploy/
│   └── whisper.container
└── scripts/
    ├── install.sh
    ├── start.sh
    └── stop.sh
```

### Example `pod-package.json`

See `examples/whisper-pod-package/pod-package.json` for the full example. High-level shape:

```json
{
  "schemaVersion": "1",
  "packageType": "pod-package",
  "name": "asmo-whisper",
  "version": "0.1.0",
  "pod": {
    "id": "whisper",
    "nickname": "Whisper",
    "description": "Speech-to-text pod for local transcription jobs.",
    "manifestVersion": "1",
    "capabilities": ["speech-to-text"],
    "runtime": {
      "kind": "http-service",
      "baseUrl": "http://127.0.0.1:8001",
      "healthPath": "/health",
      "submitPath": "/transcribe",
      "method": "POST"
    }
  },
  "artifacts": {
    "readme": "README.md",
    "dockerfile": "Dockerfile",
    "installScript": "scripts/install.sh",
    "startScript": "scripts/start.sh",
    "stopScript": "scripts/stop.sh",
    "quadlet": "deploy/whisper.container"
  },
  "directories": [
    {
      "path": "data/models",
      "purpose": "models",
      "required": true,
      "createIfMissing": true
    }
  ]
}
```

### Package contract notes

The package spec intentionally separates three things:
- **package metadata** (`name`, `version`, `schemaVersion`)
- **runnable pod manifest** (`pod`)
- **install/service hints** (`artifacts`, `directories`, `environment`, `install`, `service`)

That gives Phase 3 install flows a stable contract without prematurely locking the actual installer implementation.

## Sample manifest format

See:
- `src/manifests/builtin.ts`
- `manifests/example.custom-pod.json`
- `examples/whisper-pod-package/pod-package.json`

High-level standalone pod manifest shape:

```json
{
  "id": "string",
  "nickname": "string",
  "description": "string",
  "manifestVersion": "1",
  "capabilities": ["image-generation", "speech-to-text", "ocr", "vision"],
  "source": {
    "homepage": "https://...",
    "readme": "https://...",
    "repository": "https://..."
  },
  "runtime": {
    "kind": "http-service",
    "baseUrl": "http://127.0.0.1:9000",
    "healthPath": "/health",
    "submitPath": "/jobs",
    "resultPath": "/jobs/:id",
    "method": "POST"
  },
  "startup": {
    "command": "docker compose up -d my-pod"
  },
  "shutdown": {
    "command": "docker compose stop my-pod"
  },
  "exclusivityGroup": "gpu-0",
  "metadata": {}
}
```

## Project layout

- `src/server.ts` — Fastify app and routes
- `src/job-manager.ts` — queue + job lifecycle
- `src/router.ts` — job-to-pod routing
- `src/pod-controller.ts` — runtime state + exclusivity switching
- `src/registry.ts` — pod registry
- `src/adapters.ts` — execution adapter abstraction
- `src/schemas.ts` — Zod schemas for request validation and pod/package manifests
- `src/manifests/builtin.ts` — bundled pod definitions
- `src/manifests/local-registry-index.json` — first local sample alias/index catalog
- `examples/whisper-pod-package/` — example portable pod package layout
- `test/*.test.ts` — core scheduler/job/API/schema tests

## Future work / roadmap

Near-term:
- real HTTP adapter with retries, polling, and timeout handling
- persist jobs to SQLite/Postgres instead of memory
- webhook or websocket notifications for job updates
- execute startup/shutdown commands instead of simulated delays
- richer scheduling policies (priority, concurrency lanes, cost-aware routing)
- health checks and pod warmup policies

## Registry sources and alias resolution

Phase 3 now includes a small registry/index layer intended to sit in front of future `POST /pods/create` install flows.

### Supported registry source kinds

Each alias can resolve to one of three source models:

- `local-file`
  - points at a local folder or manifest path already present on disk
  - useful for built-in packages, checked-in examples, or pre-seeded host content
- `github-repo`
  - points at an `owner/repo` GitHub source, with optional `ref`, `subpath`, and `packageManifestPath`
  - this is the intended default for community pod packages
- `registry-index`
  - points at another registry index URL plus an alias to resolve there
  - useful for delegating from a local shorthand like `vision` to a broader remote catalog

### Registry index format

Canonical index document shape:

```json
{
  "schemaVersion": "1",
  "indexType": "pod-registry-index",
  "name": "asmo-local-sample-index",
  "entries": [
    {
      "alias": "whisper",
      "packageName": "asmo-whisper",
      "podId": "whisper",
      "source": {
        "kind": "local-file",
        "path": "examples/whisper-pod-package",
        "packageManifestPath": "examples/whisper-pod-package/pod-package.json"
      }
    }
  ]
}
```

Entry fields are intentionally small for now:
- `alias` — user-facing shorthand like `vision` or `whisper`
- `packageName` — portable package identity
- `podId` — optional runnable pod id if known up front
- `capabilities` / `tags` — optional lookup hints for UI/client layers
- `source` — where install/create flow should fetch or resolve the package from

### Local sample index

A first checked-in sample index now lives at:
- `src/manifests/local-registry-index.json`

It currently demonstrates:
- `whisper` → local file/package example
- `comfy` → direct GitHub repo source
- `vision` → registry-index delegation to a remote alias

### Registry API surface in code

`PodRegistry` now supports:
- `addRegistryIndex(index)`
- `registerAlias(entry)`
- `listRegistryIndexes()`
- `listAliases()`
- `resolveAlias(alias)`

This keeps the registry/index work small and composable without prematurely implementing full package installation.

## Future work / roadmap

Near-term:
- real HTTP adapter with retries, polling, and timeout handling
- persist jobs to SQLite/Postgres instead of memory
- webhook or websocket notifications for job updates
- execute startup/shutdown commands instead of simulated delays
- richer scheduling policies (priority, concurrency lanes, cost-aware routing)
- health checks and pod warmup policies

Planned packaging feature:
- unpack and validate pod packages from git/archive sources
- register installed package metadata
- optionally build/install the pod on the local host

## Current limitations

This first pass intentionally keeps a few things stubbed/small:
- adapter execution is mocked instead of performing real service HTTP calls
- no persistent job store
- no auth/rate limiting
- pod lifecycle commands are described in manifests but not executed yet
- package schema exists, but create/install flows are still future work
- only FIFO scheduling for now

## License

MIT
