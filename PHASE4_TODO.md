# Phase 4 — Production Hardening & Real Execution

Goal: Make asmo-pod-orchestrator actually execute real workloads end-to-end, persist state, and be publishable to npm/ClaWHub.

## Task List

### A. Real HTTP Adapter (priority: highest)
- [x] Replace mocked `HttpPodAdapter` with real HTTP calls to pod endpoints
- [x] Support form-data file uploads (for whisper/vision jobs with file attachments)
- [x] Support JSON body submissions (for comfyui/image-gen jobs)
- [x] Add configurable retry logic (exponential backoff, max retries)
  - Per-manifest `retry: { maxRetries, baseDelayMs, maxDelayMs }` on HttpServiceRuntime
  - Global defaults via `HttpPodAdapterOptions`; only retries retriable errors (5xx, network)
- [x] Add request timeout handling
  - Per-manifest `requestTimeoutMs` on HttpServiceRuntime; uses independent AbortController layered on context signal
- [x] Add async polling support for long-running jobs (poll resultPath until done)
  - If `runtime.resultPath` is set, polls after submit; configurable `pollingIntervalMs`/`pollingTimeoutMs`
  - Handles 404/202 as "not ready", checks `status` field for terminal states
- [x] Handle pod-specific response parsing per capability (transcript extraction, image URL extraction, etc.)
  - `normalizeCompletedResult` handles ComfyUI (images/generatedImages), Whisper (transcript/text/segments), vision (detections/objects/labels)
- [x] Integration with rpod adapter (real rpod exec calls, not just stubs)

### B. Execute Lifecycle Commands (priority: highest — unblocks real pod usage)
- [x] Actually execute `startup.command` when starting a pod (shell exec with timeout)
- [x] Actually execute `shutdown.command` when stopping a pod
- [x] Actually execute `install.command` during create flow
- [x] Actually execute `build.command` if defined
- [x] Add lifecycle command timeout configuration
  - Per-step `timeoutMs` field on each lifecycle step (install/build/startup/shutdown); default 120s
  - Passed to Node `exec()` timeout option which sends SIGTERM on expiry
- [x] Add lifecycle command output capture/logging
  - `PodController.getLastLifecycleOutput(podId)` returns `{ stdout, stderr }` from last command
  - Stored per-pod in runtime state for debugging
- [x] Health check polling after startup (hit healthPath until 200 or timeout)
  - Per-manifest `healthCheck: { timeoutMs, intervalMs }` on both HttpServiceRuntime and RpodRuntime
  - Defaults: http 15s/500ms, rpod 30s/1s
- [x] Graceful degradation if shutdown command fails
  - Shutdown errors are caught, logged to stderr, pod still marked as stopped

### C. Persistent Job Store (priority: high)
- [x] Add SQLite-backed job store (better-sqlite3 or similar)
  - `better-sqlite3` added as production dependency; `@types/better-sqlite3` as dev dependency
  - New `JobStore` interface in `src/job-store.ts` with `InMemoryJobStore` (default) and `SqliteJobStore` implementations
- [x] Migrate JobManager from in-memory Map to SQLite
  - `JobManager` accepts optional `store: JobStore` in options; defaults to `InMemoryJobStore` for backward compat
  - Pass `SqliteJobStore` via `JobManagerOptions.store` to enable persistence
- [x] Persist job state transitions (queued → running → completed/failed)
  - `JobManager.processNext()` calls `store.save(job)` after each state mutation
  - On restart, running jobs are marked failed with `PROCESS_RESTART` error; queued jobs recoverable via `getQueuedJobIds()`
- [x] Persist job results and error payloads
  - `result` and `error` fields serialized as JSON in SQLite; full round-trip fidelity verified by tests
- [x] Add job expiration/cleanup (configurable TTL)
  - `ASMO_JOB_TTL_MS` env var (default 24h); `SqliteJobStore.cleanup(ttlMs)` removes expired completed/failed jobs
  - Auto-cleanup timer (default 1h interval, `.unref()`'d so it doesn't block process exit)
  - DB path configurable via `ASMO_JOB_DB_PATH` env var (default `./data/jobs.db`)
- [x] Ensure backward-compatible API responses
  - All existing `JobManager` public methods preserved; routes unchanged; 131 tests pass (19 new)

### D. Auth & Rate Limiting (priority: medium)
- [x] Add optional API key authentication (Bearer token)
  - `authPlugin` in `src/auth.ts`; enabled when `apiKeys` option is set (comma-separated)
  - Bearer token validation; 401 with structured error for missing/invalid keys
- [x] Add per-key or global rate limiting
  - `@fastify/rate-limit` wired into `buildApp`; configurable `max` and `windowMs`; returns 429 with structured error
- [x] Add configurable auth bypass for localhost
  - Localhost (127.0.0.1, ::1) bypasses auth by default; `requireLocalhost: true` disables bypass
- [x] Store API keys in config/env (not hardcoded)
  - Keys passed via `AuthPluginOptions.apiKeys`; CLI reads from `ASMO_API_KEYS` env var (comma-separated)

### E. Multipart Archive Uploads (priority: medium)
- [x] Add multipart/form-data upload support on `POST /pods/create`
  - `@fastify/multipart` registered on the Fastify app; multipart requests stream the `archive` file field to a temp directory
  - Metadata fields (`alias`, `subpath`, `packageManifestPath`) read from text parts
  - Constructs an `UploadedArchiveRegistrySource` with `archivePath` pointing to the streamed file on disk
- [x] Stream archive to disk instead of requiring full base64 in JSON
  - Uses `pipeline(part.file, createWriteStream(archiveTempPath))` for zero-copy streaming
  - Temp directory cleaned up in `finally` block after create flow completes
- [x] Keep existing JSON/base64 path as fallback
  - Non-multipart requests fall through to the existing JSON body parsing path
  - `writeUploadedArchive` in create-flow.ts checks `source.archivePath` first (multipart), then falls back to base64 decoding
- [x] Add upload size limits as Fastify plugin config
  - `uploadMaxBytes` option on `AppDependencies` (default 50 MiB); passed to `@fastify/multipart` `limits.fileSize`
  - Truncated uploads detected via `part.file.truncated` and return 413 with `UPLOAD_TOO_LARGE` error
  - Fix: added `archivePath` to the uploaded-archive Zod schema so it survives `podCreateRequestSchema.parse()`

### F. Smarter Scheduling (priority: lower)
- [ ] Add job priority levels (low/normal/high/critical)
- [ ] Add per-pod concurrency limits
- [ ] Add capability-aware cost routing (prefer cheaper/faster pod when multiple match)
- [ ] Add job queue position reporting
- [x] Add job cancellation support
  - `POST /jobs/:id/cancel` endpoint; queued jobs immediately transition to `cancelled`; running jobs abort via AbortController
  - New `cancelled` terminal state alongside `completed`/`failed`; `ConflictError` (409) for already-terminal jobs
  - `JobManager.cancelJob()` removes from queue or aborts in-flight execution; cleanup/TTL includes cancelled jobs

## Working Order

1. **A + B together** (real adapter + lifecycle execution) — these unblock actual pod usage
2. **C** (persistent jobs) — needed before publish so restarts don't lose state
3. **D** (auth) — needed before exposing to network
4. **E** (multipart uploads) — nice to have for remote clients
5. **F** (scheduling) — polish for multi-user/multi-job scenarios

## Notes

- Target: publishable to npm as `asmo-pod-orchestrator` + ClaWHub as a skill
- First real test target: Hecate (they/them) running ComfyUI image generation via the orchestrator on razerblade
- All tests must pass before each chunk is considered done
- Check off items as completed; add implementation notes under tasks
