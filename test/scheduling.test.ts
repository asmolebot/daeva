import { describe, expect, it } from 'vitest';

import { inferCapabilityForJobType } from '../src/job-contracts.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import type { JobRequest, PodManifest } from '../src/types.js';
import { testManifests } from './helpers.js';

/** Adapter that records execution order. Resolves instantly. */
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
        files: []
      },
      output: {
        kind: request.capability ?? inferCapabilityForJobType(request.type),
        raw: { ok: true }
      }
    };
  }
}

/** Adapter that takes a configurable delay. */
class SlowAdapter {
  readonly seen: Array<{ podId: string; type: string }> = [];
  constructor(private readonly delayMs = 200) {}

  async execute(manifest: PodManifest, request: JobRequest) {
    this.seen.push({ podId: manifest.id, type: request.type });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      status: 'succeeded' as const,
      pod: { id: manifest.id, nickname: manifest.nickname, runtime: manifest.runtime },
      request: {
        type: request.type,
        capability: request.capability ?? inferCapabilityForJobType(request.type),
        inputKeys: Object.keys(request.input),
        files: []
      },
      output: {
        kind: request.capability ?? inferCapabilityForJobType(request.type),
        raw: { ok: true }
      }
    };
  }
}

/**
 * Helper: build a minimal pod manifest for testing scheduling features.
 */
const makePod = (overrides: Partial<PodManifest> & Pick<PodManifest, 'id' | 'capabilities'>): PodManifest => ({
  nickname: overrides.id,
  description: `Test pod ${overrides.id}`,
  manifestVersion: '1',
  source: {},
  runtime: {
    kind: 'http-service',
    baseUrl: 'http://127.0.0.1:9999',
    submitPath: '/submit',
    method: 'POST'
  },
  ...overrides
});

// ── Priority Tests ──────────────────────────────────────────────────────

describe('Job Priority Levels', () => {
  it('processes higher-priority jobs before lower-priority ones', async () => {
    const adapter = new SlowAdapter(50);
    const pod = makePod({ id: 'img-pod', capabilities: ['image-generation'] });
    const registry = new PodRegistry([pod]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter });

    // Enqueue a blocking job first (occupies the pod)
    manager.enqueue({
      type: 'generate-image',
      input: { prompt: 'blocker' }
    });

    // While blocker is running, enqueue jobs with different priorities
    // They should be ordered by priority in the queue
    const low = manager.enqueue({
      type: 'generate-image',
      priority: 'low',
      input: { prompt: 'low' }
    });
    const critical = manager.enqueue({
      type: 'generate-image',
      priority: 'critical',
      input: { prompt: 'critical' }
    });
    const high = manager.enqueue({
      type: 'generate-image',
      priority: 'high',
      input: { prompt: 'high' }
    });
    const normal = manager.enqueue({
      type: 'generate-image',
      input: { prompt: 'normal' }
    });

    // Check queue order: critical, high, normal, low
    expect(manager.getQueuePosition(critical.id)).toBe(1);
    expect(manager.getQueuePosition(high.id)).toBe(2);
    expect(manager.getQueuePosition(normal.id)).toBe(3);
    expect(manager.getQueuePosition(low.id)).toBe(4);

    await manager.waitForIdle();

    // Verify execution order (after the blocker): critical, high, normal, low
    const afterBlocker = adapter.seen.slice(1);
    expect(afterBlocker.map((e) => e.type)).toEqual([
      'generate-image',
      'generate-image',
      'generate-image',
      'generate-image'
    ]);

    // Check that all jobs completed
    expect(manager.getJob(critical.id).status).toBe('completed');
    expect(manager.getJob(high.id).status).toBe('completed');
    expect(manager.getJob(normal.id).status).toBe('completed');
    expect(manager.getJob(low.id).status).toBe('completed');
  });

  it('sets priority on the JobRecord', () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter: new RecordingAdapter() });

    const job = manager.enqueue({
      type: 'generate-image',
      priority: 'high',
      input: { prompt: 'test' }
    });

    expect(manager.getJob(job.id).priority).toBe('high');
  });

  it('defaults priority to normal when not specified', () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter: new RecordingAdapter() });

    const job = manager.enqueue({
      type: 'generate-image',
      input: { prompt: 'test' }
    });

    expect(manager.getJob(job.id).priority).toBe('normal');
  });
});

// ── Per-Pod Concurrency Limit Tests ─────────────────────────────────────

describe('Per-Pod Concurrency Limits', () => {
  it('respects maxConcurrentJobs on a pod', async () => {
    const adapter = new SlowAdapter(100);
    const pod = makePod({
      id: 'concurrent-pod',
      capabilities: ['image-generation'],
      maxConcurrentJobs: 2
    });
    const registry = new PodRegistry([pod]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter });

    // Enqueue 3 jobs. With maxConcurrentJobs=2, first 2 should run concurrently,
    // third should wait.
    const job1 = manager.enqueue({ type: 'generate-image', input: { prompt: 'a' } });
    const job2 = manager.enqueue({ type: 'generate-image', input: { prompt: 'b' } });
    const job3 = manager.enqueue({ type: 'generate-image', input: { prompt: 'c' } });

    // Allow scheduling to complete (microtask)
    await new Promise((resolve) => setTimeout(resolve, 10));

    // First two should be running, third should be queued
    expect(manager.getJob(job1.id).status).toBe('running');
    expect(manager.getJob(job2.id).status).toBe('running');
    expect(manager.getJob(job3.id).status).toBe('queued');
    expect(controller.getActiveJobCount('concurrent-pod')).toBe(2);

    await manager.waitForIdle();

    // All should complete
    expect(manager.getJob(job1.id).status).toBe('completed');
    expect(manager.getJob(job2.id).status).toBe('completed');
    expect(manager.getJob(job3.id).status).toBe('completed');
  });

  it('defaults maxConcurrentJobs to 1', async () => {
    const adapter = new SlowAdapter(100);
    const pod = makePod({ id: 'serial-pod', capabilities: ['image-generation'] });
    const registry = new PodRegistry([pod]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter });

    manager.enqueue({ type: 'generate-image', input: { prompt: 'a' } });
    const job2 = manager.enqueue({ type: 'generate-image', input: { prompt: 'b' } });

    // Allow scheduling
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second job should be queued (default maxConcurrentJobs = 1)
    expect(manager.getJob(job2.id).status).toBe('queued');

    await manager.waitForIdle();
    expect(manager.getJob(job2.id).status).toBe('completed');
  });
});

// ── Cost Routing Tests ──────────────────────────────────────────────────

describe('Capability-Aware Cost Routing', () => {
  it('prefers the pod with lower costWeight', () => {
    const cheapPod = makePod({
      id: 'cheap-ocr',
      capabilities: ['ocr'],
      costWeight: 0.5
    });
    const expensivePod = makePod({
      id: 'expensive-ocr',
      capabilities: ['ocr'],
      costWeight: 2.0
    });
    const registry = new PodRegistry([expensivePod, cheapPod]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);

    const selected = router.selectPod({
      type: 'ocr-document',
      capability: 'ocr',
      input: {}
    });

    expect(selected.id).toBe('cheap-ocr');
  });

  it('falls back to running pod with capacity even if costlier', () => {
    const cheapPod = makePod({
      id: 'cheap-ocr',
      capabilities: ['ocr'],
      costWeight: 0.5,
      maxConcurrentJobs: 1
    });
    const expensivePod = makePod({
      id: 'expensive-ocr',
      capabilities: ['ocr'],
      costWeight: 2.0,
      maxConcurrentJobs: 1
    });
    const registry = new PodRegistry([cheapPod, expensivePod]);
    const controller = new PodController(registry.list());

    // Simulate: expensive pod is running with capacity, cheap pod is stopped
    controller.markJobStarted('cheap-ocr', 'fake-job');
    // cheap-ocr is now at capacity (1 active, max 1)
    // expensive-ocr is stopped but has capacity

    // Start expensive-ocr so it's running
    // The router prefers running pods with capacity
    // Since cheap is at capacity, it should pick expensive (not running yet, but with capacity)
    const router = new SchedulerRouter(registry, controller);
    const selected = router.selectPod({
      type: 'ocr-document',
      capability: 'ocr',
      input: {}
    });

    // cheap-ocr is at capacity, so expensive-ocr should be selected
    expect(selected.id).toBe('expensive-ocr');

    controller.markJobFinished('cheap-ocr', 'fake-job');
  });

  it('uses costWeight=1 as default when not specified', () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['ocr'], costWeight: 0.5 });
    const podB = makePod({ id: 'pod-b', capabilities: ['ocr'] }); // default 1
    const podC = makePod({ id: 'pod-c', capabilities: ['ocr'], costWeight: 1.5 });

    const registry = new PodRegistry([podC, podB, podA]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);

    const selected = router.selectPod({
      type: 'ocr-document',
      capability: 'ocr',
      input: {}
    });

    expect(selected.id).toBe('pod-a');
  });
});

// ── Queue Position Reporting Tests ──────────────────────────────────────

describe('Job Queue Position Reporting', () => {
  it('reports correct queue position for queued jobs', async () => {
    const adapter = new SlowAdapter(200);
    const pod = makePod({ id: 'pos-pod', capabilities: ['image-generation'] });
    const registry = new PodRegistry([pod]);
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter });

    // First job will start running
    manager.enqueue({ type: 'generate-image', input: { prompt: 'running' } });
    const second = manager.enqueue({ type: 'generate-image', input: { prompt: 'second' } });
    const third = manager.enqueue({ type: 'generate-image', input: { prompt: 'third' } });

    expect(manager.getQueuePosition(second.id)).toBe(1);
    expect(manager.getQueuePosition(third.id)).toBe(2);

    await manager.waitForIdle();
  });

  it('returns null for running or completed jobs', async () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const adapter = new RecordingAdapter();
    const manager = new JobManager(registry, controller, router, { adapter });

    const job = manager.enqueue({
      type: 'generate-image',
      input: { prompt: 'test' }
    });

    await manager.waitForIdle();

    // Job is completed — should not have a queue position
    expect(manager.getQueuePosition(job.id)).toBeNull();
  });

  it('returns null for unknown job IDs', () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter: new RecordingAdapter() });

    expect(manager.getQueuePosition('job_nonexistent')).toBeNull();
  });
});

// ── hotSwapMode Tests ─────────────────────────────────────────────────────

describe('hotSwapMode', () => {
  it('skips tearing down other pods when target is already running', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0' });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0' });
    const registry = new PodRegistry([podA, podB]);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { hotSwapMode: true }
    });

    // Start both pods manually (simulating previous use)
    await controller.start(podA);
    await controller.start(podB);
    expect(controller.getStatus('pod-a')).toBe('running');
    expect(controller.getStatus('pod-b')).toBe('running');

    // ensureExclusive for pod-a: with hotSwapMode, pod-b should NOT be stopped
    await controller.ensureExclusive(podA, [podA, podB]);

    expect(controller.getStatus('pod-a')).toBe('running');
    expect(controller.getStatus('pod-b')).toBe('running'); // preserved!
  });

  it('still swaps when the target is NOT running', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0' });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0' });
    const registry = new PodRegistry([podA, podB]);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { hotSwapMode: true }
    });

    await controller.start(podA);
    expect(controller.getStatus('pod-a')).toBe('running');

    // ensureExclusive for pod-b (not running): pod-a should be stopped
    await controller.ensureExclusive(podB, [podA, podB]);

    expect(controller.getStatus('pod-a')).toBe('stopped');
    expect(controller.getStatus('pod-b')).toBe('running');
  });

  it('preserves default behavior when hotSwapMode is off', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0' });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0' });
    const registry = new PodRegistry([podA, podB]);
    const controller = new PodController(registry.list()); // default config

    await controller.start(podA);
    await controller.start(podB);

    // Default: ensureExclusive for pod-a should stop pod-b even though pod-a is running
    await controller.ensureExclusive(podA, [podA, podB]);

    expect(controller.getStatus('pod-a')).toBe('running');
    expect(controller.getStatus('pod-b')).toBe('stopped');
  });
});

// ── autoFitPods Tests ─────────────────────────────────────────────────────

describe('autoFitPods', () => {
  it('allows concurrent pods when VRAM budget permits', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0', vramMB: 4000 });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0', vramMB: 3000 });
    const registry = new PodRegistry([podA, podB]);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { autoFitPods: true, gpuCapacityMB: 8000 }
    });

    await controller.start(podA);
    expect(controller.getStatus('pod-a')).toBe('running');

    // pod-b (3000 MB) should fit alongside pod-a (4000 MB) within 8000 MB budget
    await controller.ensureExclusive(podB, [podA, podB]);

    expect(controller.getStatus('pod-a')).toBe('running'); // NOT stopped
    expect(controller.getStatus('pod-b')).toBe('running');
  });

  it('evicts idle pods when VRAM budget is exceeded', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0', vramMB: 6000 });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0', vramMB: 6000 });
    const registry = new PodRegistry([podA, podB]);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { autoFitPods: true, gpuCapacityMB: 8000 }
    });

    await controller.start(podA);
    expect(controller.getStatus('pod-a')).toBe('running');

    // pod-b (6000 MB) + pod-a (6000 MB) = 12000 > 8000 → pod-a must be evicted
    await controller.ensureExclusive(podB, [podA, podB]);

    expect(controller.getStatus('pod-a')).toBe('stopped');
    expect(controller.getStatus('pod-b')).toBe('running');
  });

  it('evicts only the minimum number of peers needed', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0', vramMB: 2000 });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0', vramMB: 3000 });
    const podC = makePod({ id: 'pod-c', capabilities: ['ocr'], exclusivityGroup: 'gpu-0', vramMB: 4000 });
    const all = [podA, podB, podC];
    const registry = new PodRegistry(all);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { autoFitPods: true, gpuCapacityMB: 8000 }
    });

    // Start A (2000) and B (3000) — total 5000
    await controller.start(podA);
    await controller.start(podB);

    // Start C (4000) — total would be 9000, over 8000. Need to free ≥1000.
    // Evict biggest idle first: B (3000) frees enough. A should survive.
    await controller.ensureExclusive(podC, all);

    expect(controller.getStatus('pod-a')).toBe('running');
    expect(controller.getStatus('pod-b')).toBe('stopped');
    expect(controller.getStatus('pod-c')).toBe('running');
  });

  it('treats pods without vramMB as consuming the entire budget', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0' }); // no vramMB
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0', vramMB: 2000 });
    const all = [podA, podB];
    const registry = new PodRegistry(all);
    const controller = new PodController(registry.list(), {
      schedulerConfig: { autoFitPods: true, gpuCapacityMB: 8000 }
    });

    await controller.start(podA);

    // pod-a has no vramMB → assumed to use full 8000. pod-b can't fit.
    await controller.ensureExclusive(podB, all);

    expect(controller.getStatus('pod-a')).toBe('stopped');
    expect(controller.getStatus('pod-b')).toBe('running');
  });

  it('falls back to strict exclusivity when autoFitPods is off', async () => {
    const podA = makePod({ id: 'pod-a', capabilities: ['image-generation'], exclusivityGroup: 'gpu-0', vramMB: 2000 });
    const podB = makePod({ id: 'pod-b', capabilities: ['speech-to-text'], exclusivityGroup: 'gpu-0', vramMB: 2000 });
    const all = [podA, podB];
    const registry = new PodRegistry(all);
    const controller = new PodController(registry.list()); // default: autoFitPods off

    await controller.start(podA);

    // Even though both pods would fit in any budget, default stops all peers
    await controller.ensureExclusive(podB, all);

    expect(controller.getStatus('pod-a')).toBe('stopped');
    expect(controller.getStatus('pod-b')).toBe('running');
  });
});
