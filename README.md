# Daeva

Local GPU pod orchestrator for AI workloads. One process to register, schedule, and manage containerized AI services (pods) on a single host with shared GPU resources.

## Features

- **Pod registry** — register and discover GPU-backed AI services
- **Job queue** — submit async jobs, route them to capable pods, track results
- **Exclusivity groups** — automatic stop/switch when pods contend for the same GPU
- **Pod packages** — portable `pod-package.json` format for distributing pod definitions
- **Package install** — materialize packages from local paths, Git repos, archives, or registries
- **MCP server** — expose orchestrator capabilities to AI coding assistants via `daeva-mcp`
- **Built-in pods** — bundled compatibility manifests for ComfyUI, Whisper, and OCR/Vision

## Install

```bash
npm install -g @asmostans/daeva
```

Or from source:

```bash
git clone https://github.com/openclaw/daeva.git
cd daeva
npm install
npm run build
```

### Platform installers

Platform-specific install scripts handle Node.js, Podman, and service setup:

```bash
# Linux (apt/dnf/pacman)
curl -fsSL https://asmo.bot/install-linux.sh | bash

# macOS (Homebrew)
curl -fsSL https://asmo.bot/install-macos.sh | bash

# Windows (PowerShell, winget/choco)
irm https://asmo.bot/install-windows.ps1 | iex
```

All scripts support `--dry-run`, `--skip-podman`, `--skip-service`, and more. Run with `--help` for details.

## Quickstart

Start the server:

```bash
daeva
# Listening on http://127.0.0.1:8787
```

Submit a job:

```bash
curl -X POST http://127.0.0.1:8787/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type": "transcribe-audio", "files": [{"source": "path", "path": "/tmp/demo.wav"}]}'
```

Check status:

```bash
curl http://127.0.0.1:8787/status
```

List pods:

```bash
curl http://127.0.0.1:8787/pods
```

Install a pod package:

```bash
curl -X POST http://127.0.0.1:8787/pods/create \
  -H 'Content-Type: application/json' \
  -d '{"alias": "comfyapi"}'
```

Then point Comfy clients at Daeva's proxy instead of raw port 8188:

```bash
export DAEVA_BASE=http://127.0.0.1:8787
curl "$DAEVA_BASE/proxy/comfyapi/system_stats"
```

For `comfyapi` image jobs, Daeva now submits a real Comfy workflow payload to `/prompt` and polls `/history/<prompt_id>`. Packaged Comfy manifests should provide workflow metadata with `workflowPath` (or `path`), `promptNodeId`, optional `promptInputName` (defaults to `text`), and optional `outputNodeId`.

## MCP server

Daeva ships a stdio-based MCP server binary for integration with AI coding assistants:

```bash
daeva-mcp --base-url http://127.0.0.1:8787
```

Add to your MCP client config:

```json
{
  "command": "daeva-mcp",
  "args": ["--base-url", "http://127.0.0.1:8787"]
}
```

## Configuration

| Env var    | CLI flag       | Default       | Description          |
|------------|----------------|---------------|----------------------|
| `PORT`     | `--port`       | `8787`        | HTTP listen port     |
| `HOST`     | `--host`       | `0.0.0.0`     | HTTP listen address  |
| `DATA_DIR` | `--data-dir`   | `.data`       | Data/storage path    |

## REST API

### Core endpoints

| Method | Path                      | Description                          |
|--------|---------------------------|--------------------------------------|
| GET    | `/health`                 | Liveness probe                       |
| GET    | `/pods`                   | List pods and runtime state          |
| POST   | `/pods/register`          | Register a new pod manifest          |
| POST   | `/pods/create`            | Install a pod package by alias       |
| GET    | `/pods/aliases`           | List registry aliases                |
| GET    | `/pods/installed`         | List installed packages              |
| POST   | `/pods/:podId/activate`   | Start or activate a pod explicitly   |
| POST   | `/pods/:podId/stop`       | Stop a pod explicitly                |
| POST   | `/pods/swap`              | Swap to a target pod server-side     |
| POST   | `/jobs`                   | Submit an async job                  |
| GET    | `/jobs`                   | List jobs                            |
| GET    | `/jobs/:id`               | Get job state                        |
| GET    | `/jobs/:id/result`        | Get job result                       |

### Observability

| Method | Path                      | Description                          |
|--------|---------------------------|--------------------------------------|
| GET    | `/status`                 | Combined status snapshot             |
| GET    | `/status/runtime`         | Pod runtime + container inspection   |
| GET    | `/status/packages`        | Installed packages + registry state  |
| GET    | `/status/scheduler`       | Queue depth + exclusivity groups     |
| GET    | `/status/jobs/recent`     | Recent job history                   |

## Pod packages

Daeva uses a portable `pod-package.json` format. Minimal example:

```json
{
  "schemaVersion": "1",
  "packageType": "pod-package",
  "name": "daeva-whisper",
  "version": "0.1.0",
  "pod": {
    "id": "whisper",
    "nickname": "Whisper",
    "description": "Speech-to-text pod",
    "manifestVersion": "1",
    "capabilities": ["speech-to-text"],
    "runtime": {
      "kind": "http-service",
      "baseUrl": "http://127.0.0.1:8001",
      "submitPath": "/transcribe",
      "method": "POST"
    }
  }
}
```

See `examples/whisper-pod-package/` for a complete example with Dockerfile, deploy scripts, and directory scaffolding.

### Package sources

Packages can be installed from:
- **local-file** — local directory with a `pod-package.json`
- **github-repo** — GitHub `owner/repo` with optional ref and subpath
- **git-repo** — arbitrary Git URL
- **uploaded-archive** — `.tar.gz` or `.zip` uploaded directly
- **registry-index** — delegated lookup from a registry catalog

During install, Daeva now runs package install hooks, creates declared host directories, and persists resolved host-path template variables (for example `MODELS_DIR`, `INPUT_DIR`, `HOST_DIR_1`) alongside installed package metadata.

## Built-in pods

| Pod ID      | Capabilities                | Description                     |
|-------------|-----------------------------|---------------------------------|
| `comfyapi`  | image-generation, vision    | ComfyUI compatibility manifest, prefer the packaged `comfyapi` alias |
| `whisper`   | speech-to-text              | Whisper transcription           |
| `ocr-vision`| ocr, vision                 | OCR and visual analysis         |

## Project layout

```
src/server.ts              Fastify app and routes
src/cli.ts                 CLI entry point (daeva binary)
src/mcp-cli.ts             MCP server entry point (daeva-mcp binary)
src/job-manager.ts         Queue + job lifecycle
src/router.ts              Job-to-pod routing
src/pod-controller.ts      Runtime state + exclusivity switching
src/registry.ts            Pod registry + alias resolution
src/adapters.ts            Execution adapter abstraction
src/schemas.ts             Zod schemas for manifests + validation
src/manifests/builtin.ts   Bundled pod definitions
examples/                  Pod package examples
scripts/                   Platform install scripts
```

## Development

```bash
npm install
npm run dev          # dev server with tsx
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
```

## License

MIT
