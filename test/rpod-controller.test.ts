/**
 * Tests for PodController routing when runtime.kind === 'rpod'.
 *
 * We mock the rpod-adapter module to avoid real CLI calls,
 * then verify the controller calls the right adapter functions.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PodController } from '../src/pod-controller.js';
import type { PodManifest, RpodRuntime } from '../src/types.js';

// Mock the rpod-adapter module
vi.mock('../src/rpod-adapter.js', () => ({
  rpodRun: vi.fn().mockResolvedValue('mock-pod-id-42'),
  rpodStop: vi.fn().mockResolvedValue(undefined),
  rpodIsRunning: vi.fn().mockResolvedValue(true),
  executeViaRpod: vi.fn().mockResolvedValue({ status: 'succeeded', output: { kind: 'image-generation' } }),
  setRpodPodId: vi.fn(),
  getRpodPodId: vi.fn().mockReturnValue('mock-pod-id-42'),
  clearRpodPodId: vi.fn()
}));

import * as rpodAdapter from '../src/rpod-adapter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRpodManifest = (id = 'rpod-test'): PodManifest => ({
  id,
  nickname: 'RPOD Test',
  description: 'Test rpod-backed pod',
  capabilities: ['image-generation'],
  source: {},
  runtime: {
    kind: 'rpod',
    host: 'gpu-box',
    device: 'gpu:0'
  } satisfies RpodRuntime
});

const makeHttpManifest = (id = 'http-test'): PodManifest => ({
  id,
  nickname: 'HTTP Test',
  description: 'Test http-service pod',
  capabilities: ['speech-to-text'],
  source: {},
  runtime: {
    kind: 'http-service',
    baseUrl: 'http://localhost:8001',
    submitPath: '/transcribe'
  }
});

// ---------------------------------------------------------------------------
// Controller routing tests
// ---------------------------------------------------------------------------

describe('PodController — rpod routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to default behavior
    vi.mocked(rpodAdapter.rpodRun).mockResolvedValue('mock-pod-id-42');
    vi.mocked(rpodAdapter.rpodStop).mockResolvedValue(undefined);
    vi.mocked(rpodAdapter.rpodIsRunning).mockResolvedValue(true);
    vi.mocked(rpodAdapter.getRpodPodId).mockReturnValue('mock-pod-id-42');
  });

  it('calls rpodRun on start() for rpod manifests', async () => {
    const manifest = makeRpodManifest();
    const controller = new PodController([manifest]);

    // Before start, no pod-id → isHealthy returns false → rpodRun is called
    vi.mocked(rpodAdapter.getRpodPodId).mockReturnValueOnce(undefined);
    // After rpodRun, setRpodPodId is called by the controller; rpodIsRunning returns true
    vi.mocked(rpodAdapter.rpodIsRunning).mockResolvedValue(true);

    await controller.start(manifest);

    expect(rpodAdapter.rpodRun).toHaveBeenCalledOnce();
    expect(rpodAdapter.setRpodPodId).toHaveBeenCalledWith(manifest.id, 'mock-pod-id-42');
  });

  it('does NOT call rpodRun when pod is already running', async () => {
    const manifest = makeRpodManifest();
    const controller = new PodController([manifest]);

    // First start: no pod-id → run fires
    vi.mocked(rpodAdapter.getRpodPodId).mockReturnValueOnce(undefined);
    vi.mocked(rpodAdapter.rpodIsRunning).mockResolvedValue(true);
    await controller.start(manifest);

    vi.clearAllMocks();

    // Second start — status is 'running', should return immediately without calling rpodRun
    await controller.start(manifest);
    expect(rpodAdapter.rpodRun).not.toHaveBeenCalled();
  });

  it('calls rpodStop + clearRpodPodId on stop() for rpod manifests', async () => {
    const manifest = makeRpodManifest();
    const controller = new PodController([manifest]);

    // Bring up: no pod-id initially so rpodRun is triggered
    vi.mocked(rpodAdapter.getRpodPodId).mockReturnValueOnce(undefined);
    vi.mocked(rpodAdapter.rpodIsRunning).mockResolvedValue(true);
    await controller.start(manifest);
    vi.clearAllMocks();

    // Stop — pod-id is now stored (mock returns it)
    await controller.stop(manifest);

    expect(rpodAdapter.rpodStop).toHaveBeenCalledOnce();
    expect(rpodAdapter.clearRpodPodId).toHaveBeenCalledWith(manifest.id);
    expect(controller.getStatus(manifest.id)).toBe('stopped');
  });

  it('does NOT call rpodRun/stop for http-service manifests', async () => {
    // http-service manifest — should use legacy path
    const manifest = makeHttpManifest();
    const controller = new PodController([manifest]);

    // No health path → isHealthy returns true immediately
    await controller.start(manifest);
    expect(rpodAdapter.rpodRun).not.toHaveBeenCalled();
  });

  it('getStatus reflects lifecycle transitions', async () => {
    const manifest = makeRpodManifest();
    const controller = new PodController([manifest]);

    expect(controller.getStatus(manifest.id)).toBe('stopped');

    // No pod-id initially → isHealthy returns false → rpodRun called
    // Then rpodIsRunning returns true to pass waitForHealth
    vi.mocked(rpodAdapter.getRpodPodId).mockReturnValueOnce(undefined);
    vi.mocked(rpodAdapter.rpodIsRunning).mockResolvedValue(true);

    await controller.start(manifest);
    expect(controller.getStatus(manifest.id)).toBe('running');

    await controller.stop(manifest);
    expect(controller.getStatus(manifest.id)).toBe('stopped');
  });

  it('executeRpodJob delegates to executeViaRpod', async () => {
    const manifest = makeRpodManifest();
    const controller = new PodController([manifest]);

    const request = { type: 'generate-image', capability: 'image-generation' as const, input: { prompt: 'hi' } };
    const result = await controller.executeRpodJob(manifest, request);

    expect(rpodAdapter.executeViaRpod).toHaveBeenCalledWith(manifest, request, undefined);
    expect(result.status).toBe('succeeded');
  });

  it('executeRpodJob throws for non-rpod manifests', async () => {
    const manifest = makeHttpManifest();
    const controller = new PodController([manifest]);

    await expect(
      controller.executeRpodJob(manifest, { type: 'transcribe-audio', input: {} })
    ).rejects.toThrow(/non-rpod manifest/);
  });
});
