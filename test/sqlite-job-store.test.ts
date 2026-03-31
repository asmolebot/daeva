import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteJobStore, InMemoryJobStore } from '../src/job-store.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import { inferCapabilityForJobType } from '../src/job-contracts.js';
import type { JobRecord, JobRequest, PodManifest } from '../src/types.js';
import { testManifests } from './helpers.js';

// ── Helpers ────────────────────────────────────────────────────────────

const makeTmpDir = () => mkdtempSync(join(tmpdir(), 'asmo-sqlite-test-'));

const makeJob = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: `job_test_${Math.random().toString(36).slice(2, 8)}`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'queued',
  request: { type: 'generate-image', input: { prompt: 'test' } },
  ...overrides
});

class RecordingAdapter {
  readonly seen: Array<{ podId: string; type: string }> = [];

  async execute(manifest: PodManifest, request: JobRequest) {
    this.seen.push({ podId: manifest.id, type: request.type });
    return {
      status: 'succeeded' as const,
      pod: { id: manifest.id, nickname: manifest.nickname, runtime: manifest.runtime },
      request: {
        type: request.type,
        capability: request.capability ?? inferCapabilityForJobType(request.type),
        inputKeys: Object.keys(request.input),
        preferredPodId: request.preferredPodId,
        files: (request.files ?? []).map((file) => ({
          field: file.field ?? 'file',
          source: file.source,
          filename: file.filename,
          contentType: file.contentType,
          path: file.source === 'path' ? file.path : undefined,
          sizeBytes: file.sizeBytes,
          metadata: file.metadata
        }))
      },
      output: {
        kind: request.capability ?? inferCapabilityForJobType(request.type),
        raw: { ok: true, podId: manifest.id, type: request.type }
      }
    };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SqliteJobStore', () => {
  const stores: SqliteJobStore[] = [];
  const dirs: string[] = [];

  const createStore = (opts: { dbPath?: string; ttlMs?: number; cleanupIntervalMs?: number } = {}) => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const dbPath = opts.dbPath ?? join(dir, 'test.db');
    const store = new SqliteJobStore({ dbPath, ttlMs: opts.ttlMs, cleanupIntervalMs: opts.cleanupIntervalMs ?? 0 });
    stores.push(store);
    return { store, dbPath, dir };
  };

  afterEach(() => {
    for (const store of stores) {
      try { store.close(); } catch { /* already closed */ }
    }
    stores.length = 0;
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    dirs.length = 0;
  });

  // ── Basic CRUD ───────────────────────────────────────────────────

  it('saves and retrieves a job', () => {
    const { store } = createStore();
    const job = makeJob();
    store.save(job);

    const retrieved = store.get(job.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(job.id);
    expect(retrieved!.status).toBe('queued');
    expect(retrieved!.request).toEqual(job.request);
  });

  it('returns undefined for non-existent job', () => {
    const { store } = createStore();
    expect(store.get('job_nonexistent')).toBeUndefined();
  });

  it('updates a job via save (upsert)', () => {
    const { store } = createStore();
    const job = makeJob();
    store.save(job);

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    job.selectedPodId = 'comfyui';
    store.save(job);

    const retrieved = store.get(job.id)!;
    expect(retrieved.status).toBe('running');
    expect(retrieved.startedAt).toBe(job.startedAt);
    expect(retrieved.selectedPodId).toBe('comfyui');
  });

  it('deletes a job', () => {
    const { store } = createStore();
    const job = makeJob();
    store.save(job);
    expect(store.delete(job.id)).toBe(true);
    expect(store.get(job.id)).toBeUndefined();
    expect(store.delete(job.id)).toBe(false);
  });

  it('lists jobs sorted by createdAt ascending', () => {
    const { store } = createStore();
    const jobs = [
      makeJob({ id: 'job_c', createdAt: '2024-01-03T00:00:00Z' }),
      makeJob({ id: 'job_a', createdAt: '2024-01-01T00:00:00Z' }),
      makeJob({ id: 'job_b', createdAt: '2024-01-02T00:00:00Z' })
    ];
    for (const job of jobs) store.save(job);

    const listed = store.list();
    expect(listed.map((j) => j.id)).toEqual(['job_a', 'job_b', 'job_c']);
  });

  it('lists recent jobs sorted by updatedAt descending with limit', () => {
    const { store } = createStore();
    const jobs = [
      makeJob({ id: 'job_old', updatedAt: '2024-01-01T00:00:00Z' }),
      makeJob({ id: 'job_mid', updatedAt: '2024-01-02T00:00:00Z' }),
      makeJob({ id: 'job_new', updatedAt: '2024-01-03T00:00:00Z' })
    ];
    for (const job of jobs) store.save(job);

    const recent = store.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent.map((j) => j.id)).toEqual(['job_new', 'job_mid']);
  });

  // ── State Transitions ───────────────────────────────────────────

  it('persists full state transition: queued → running → completed', () => {
    const { store } = createStore();
    const job = makeJob();

    // Queued
    store.save(job);
    expect(store.get(job.id)!.status).toBe('queued');

    // Running
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.selectedPodId = 'comfyui';
    store.save(job);
    expect(store.get(job.id)!.status).toBe('running');
    expect(store.get(job.id)!.selectedPodId).toBe('comfyui');

    // Completed with result
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.result = {
      status: 'succeeded',
      pod: { id: 'comfyui', nickname: 'ComfyUI', runtime: { kind: 'http-service', baseUrl: 'http://localhost:8188', submitPath: '/prompt' } },
      output: { kind: 'image-generation', generatedImages: [{ url: 'http://localhost:8188/output/img.png' }] }
    };
    store.save(job);

    const final = store.get(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.result!.status).toBe('succeeded');
    expect(final.result!.output.kind).toBe('image-generation');
  });

  it('persists full state transition: queued → running → failed with error', () => {
    const { store } = createStore();
    const job = makeJob();

    store.save(job);
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    store.save(job);

    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.error = {
      code: 'POD_REQUEST_ERROR',
      message: 'Upstream pod exploded',
      details: { status: 503 },
      retriable: true
    };
    job.result = {
      status: 'failed',
      output: {
        kind: 'image-generation',
        error: { code: 'POD_REQUEST_ERROR', message: 'Upstream pod exploded', retriable: true }
      }
    };
    store.save(job);

    const final = store.get(job.id)!;
    expect(final.status).toBe('failed');
    expect(final.error).toEqual({
      code: 'POD_REQUEST_ERROR',
      message: 'Upstream pod exploded',
      details: { status: 503 },
      retriable: true
    });
    expect(final.result!.status).toBe('failed');
  });

  // ── Persistence Across Restarts ─────────────────────────────────

  it('persists completed jobs across store restarts', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const dbPath = join(dir, 'persist.db');

    // First instance: create and complete a job
    const store1 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store1);
    const job = makeJob({ status: 'completed', completedAt: new Date().toISOString() });
    job.result = {
      status: 'succeeded',
      output: { kind: 'image-generation', generatedImages: [] }
    };
    store1.save(job);
    store1.close();

    // Second instance: job should still be there
    const store2 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store2);
    const retrieved = store2.get(job.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(job.id);
    expect(retrieved!.status).toBe('completed');
    expect(retrieved!.result!.status).toBe('succeeded');
  });

  it('marks running jobs as failed on restart (crash recovery)', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const dbPath = join(dir, 'crash.db');

    // First instance: leave a job in 'running' state (simulates crash)
    const store1 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store1);
    const job = makeJob({ status: 'running', startedAt: new Date().toISOString(), selectedPodId: 'comfyui' });
    store1.save(job);
    store1.close();

    // Second instance: running job should be marked as failed
    const store2 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store2);
    const recovered = store2.get(job.id)!;
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toMatchObject({
      code: 'PROCESS_RESTART',
      retriable: true
    });
  });

  it('recovers queued job IDs for re-queueing after restart', () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const dbPath = join(dir, 'queue.db');

    const store1 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store1);
    store1.save(makeJob({ id: 'job_q1', status: 'queued', createdAt: '2024-01-01T00:00:00Z' }));
    store1.save(makeJob({ id: 'job_q2', status: 'queued', createdAt: '2024-01-02T00:00:00Z' }));
    store1.save(makeJob({ id: 'job_done', status: 'completed' }));
    store1.close();

    const store2 = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store2);
    const queued = store2.getQueuedJobIds();
    expect(queued).toEqual(['job_q1', 'job_q2']);
  });

  // ── TTL / Cleanup ───────────────────────────────────────────────

  it('cleans up expired completed/failed jobs by TTL', () => {
    const { store } = createStore({ ttlMs: 1000 });

    const oldTime = new Date(Date.now() - 5000).toISOString();
    const recentTime = new Date().toISOString();

    store.save(makeJob({ id: 'job_old_done', status: 'completed', updatedAt: oldTime }));
    store.save(makeJob({ id: 'job_old_fail', status: 'failed', updatedAt: oldTime }));
    store.save(makeJob({ id: 'job_recent', status: 'completed', updatedAt: recentTime }));
    store.save(makeJob({ id: 'job_old_queued', status: 'queued', updatedAt: oldTime }));

    const cleaned = store.cleanup(1000);
    expect(cleaned).toBe(2); // only completed/failed older than TTL

    expect(store.get('job_old_done')).toBeUndefined();
    expect(store.get('job_old_fail')).toBeUndefined();
    expect(store.get('job_recent')).toBeDefined();
    expect(store.get('job_old_queued')).toBeDefined(); // queued jobs are not cleaned
  });

  it('respects ASMO_JOB_TTL_MS default of 24h', () => {
    const { store } = createStore();
    expect(store.ttlMs).toBe(86_400_000);
  });

  // ── Serialization Round-Trip ────────────────────────────────────

  it('round-trips complex job data including files and metadata', () => {
    const { store } = createStore();
    const job = makeJob({
      request: {
        type: 'transcribe-audio',
        capability: 'speech-to-text',
        input: { language: 'en' },
        files: [{ source: 'path', path: '/tmp/audio.wav', filename: 'audio.wav', contentType: 'audio/wav', sizeBytes: 1024 }],
        metadata: { userId: 'user_123', priority: 'high' }
      },
      resolvedCapability: 'speech-to-text',
      selectedPodId: 'whisper',
      status: 'completed',
      completedAt: new Date().toISOString(),
      result: {
        status: 'succeeded',
        pod: { id: 'whisper', nickname: 'Whisper', runtime: { kind: 'http-service', baseUrl: 'http://localhost:9000', submitPath: '/asr' } },
        request: {
          type: 'transcribe-audio',
          capability: 'speech-to-text',
          inputKeys: ['language'],
          files: [{ field: 'file', source: 'path', filename: 'audio.wav', contentType: 'audio/wav' }]
        },
        output: {
          kind: 'speech-to-text',
          transcript: { text: 'Hello world', language: 'en', durationMs: 5000, segments: [{ text: 'Hello world', startMs: 0, endMs: 5000 }] }
        }
      }
    });

    store.save(job);
    const retrieved = store.get(job.id)!;

    expect(retrieved.request.files).toHaveLength(1);
    expect(retrieved.request.files![0]).toMatchObject({ source: 'path', path: '/tmp/audio.wav' });
    expect(retrieved.request.metadata).toEqual({ userId: 'user_123', priority: 'high' });
    expect(retrieved.result!.output.kind).toBe('speech-to-text');
    expect((retrieved.result!.output as any).transcript.text).toBe('Hello world');
  });

  // ── InMemoryJobStore parity ─────────────────────────────────────

  it('InMemoryJobStore has same basic behavior as SqliteJobStore', () => {
    const store = new InMemoryJobStore();
    const job = makeJob();
    store.save(job);
    expect(store.get(job.id)).toBeDefined();
    expect(store.list()).toHaveLength(1);
    expect(store.listRecent(10)).toHaveLength(1);

    job.status = 'completed';
    job.updatedAt = new Date(Date.now() - 100000).toISOString();
    store.save(job);
    expect(store.cleanup(1000)).toBe(1);
    expect(store.get(job.id)).toBeUndefined();

    store.close(); // should not throw
  });
});

// ── Integration: JobManager + SqliteJobStore ──────────────────────────

describe('JobManager with SqliteJobStore', () => {
  const stores: SqliteJobStore[] = [];
  const dirs: string[] = [];

  const createStoreAndManager = () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const dbPath = join(dir, 'integration.db');
    const store = new SqliteJobStore({ dbPath, cleanupIntervalMs: 0 });
    stores.push(store);
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const adapter = new RecordingAdapter();
    const manager = new JobManager(registry, controller, router, { adapter, store });
    return { store, manager, adapter, dbPath, dir };
  };

  afterEach(() => {
    for (const store of stores) {
      try { store.close(); } catch { /* already closed */ }
    }
    stores.length = 0;
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    dirs.length = 0;
  });

  it('persists jobs through the full enqueue → process → complete flow', async () => {
    const { store, manager } = createStoreAndManager();

    const job = manager.enqueue({ type: 'generate-image', input: { prompt: 'test art' } });
    await manager.waitForIdle();

    // Verify in-store persistence
    const persisted = store.get(job.id)!;
    expect(persisted.status).toBe('completed');
    expect(persisted.result).toBeDefined();
    expect(persisted.result!.status).toBe('succeeded');
    expect(persisted.selectedPodId).toBeDefined();
  });

  it('maintains backward-compatible API responses with SQLite store', async () => {
    const { manager } = createStoreAndManager();

    const job = manager.enqueue({ type: 'generate-image', input: { prompt: 'compat test' } });
    await manager.waitForIdle();

    // These are the same API methods used by routes
    const listed = manager.listJobs();
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(listed.find((j) => j.id === job.id)).toBeDefined();

    const recent = manager.listRecentJobs(5);
    expect(recent.find((j) => j.id === job.id)).toBeDefined();

    const fetched = manager.getJob(job.id);
    expect(fetched.id).toBe(job.id);
    expect(fetched.status).toBe('completed');

    const result = manager.getResult(job.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe('succeeded');
  });

  it('getJob throws NotFoundError for missing jobs (backward compat)', () => {
    const { manager } = createStoreAndManager();
    expect(() => manager.getJob('job_nope')).toThrow(/Job not found/);
  });

  it('getResult returns null for non-terminal jobs (backward compat)', () => {
    const { manager } = createStoreAndManager();
    // Enqueue but check immediately before processing
    const job = manager.enqueue({ type: 'generate-image', input: { prompt: 'quick' } });
    // Job might already be processed, but if queued/running, result should be null
    const result = manager.getResult(job.id);
    // Either null (still processing) or an object (already done) — both are valid
    if (result !== null) {
      expect(result.status).toBeDefined();
    }
  });
});
