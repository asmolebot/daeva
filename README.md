# asmo-pod-orchestrator

A first-pass TypeScript/Node.js package for locally orchestrating GPU-backed "pods" (containerized or service-backed workers) behind a small HTTP API.

Current focus:
- Fastify REST server
- in-memory queue + scheduler
- pod registry + packaged manifests
- first-class built-ins for ComfyUI/comfyapi, Whisper, and OCR/Vision
- start/stop/switch behavior for pods that contend for the same GPU slot

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

## Sample manifest format

See:
- `src/manifests/builtin.ts`
- `manifests/example.custom-pod.json`

High-level shape:

```json
{
  "id": "string",
  "nickname": "string",
  "description": "string",
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
- `src/manifests/builtin.ts` — bundled pod definitions
- `test/*.test.ts` — core scheduler/job/API tests

## Future work / roadmap

Near-term:
- real HTTP adapter with retries, polling, and timeout handling
- persist jobs to SQLite/Postgres instead of memory
- webhook or websocket notifications for job updates
- execute startup/shutdown commands instead of simulated delays
- richer scheduling policies (priority, concurrency lanes, cost-aware routing)
- health checks and pod warmup policies

Planned packaging feature:
- upload tarball/docker context + init scripts
- unpack and validate a pod package
- register package metadata/manifests
- optionally build/install the pod on the local host

## Current limitations

This first pass intentionally keeps a few things stubbed/small:
- adapter execution is mocked instead of performing real service HTTP calls
- no persistent job store
- no auth/rate limiting
- pod lifecycle commands are described in manifests but not executed yet
- only FIFO scheduling for now

## License

MIT
