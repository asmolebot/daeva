import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PodController } from '../src/pod-controller.js';
import type { PodManifest } from '../src/types.js';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Create a manifest where start() actually runs the command.
 * We need a healthPath so isHealthy() doesn't return true immediately,
 * but mock fetch so the health check passes after the command runs.
 */
const makeManifest = (overrides: Partial<PodManifest> = {}): PodManifest => ({
  id: 'test-pod',
  nickname: 'Test Pod',
  description: 'A test pod',
  capabilities: ['image-generation'],
  source: {},
  runtime: {
    kind: 'http-service',
    baseUrl: 'http://localhost:19876',
    submitPath: '/api/submit',
    // No healthPath by default (isHealthy returns true → start() skips command)
  },
  ...overrides
});

/**
 * Make a manifest whose start() actually executes the startup command.
 * Requires a healthPath that fails initially but passes after command.
 */
const makeManifestWithHealth = (overrides: Partial<PodManifest> = {}): PodManifest => {
  let commandRan = false;
  // We'll mock fetch to fail before the command runs, succeed after
  return makeManifest({
    runtime: {
      kind: 'http-service',
      baseUrl: 'http://localhost:19876',
      submitPath: '/api/submit',
      healthPath: '/health',
      healthCheck: { timeoutMs: 2000, intervalMs: 10 }
    },
    ...overrides
  });
};

/** Mock fetch so health check returns 200 */
function mockHealthyFetch() {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => 'ok'
  }) as Response);
}

/** Mock fetch so health check fails (simulates service not yet up) */
function mockUnhealthyFetch() {
  globalThis.fetch = vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  });
}

/**
 * Mock fetch: first N calls fail, then succeed.
 * Useful for simulating service starting up.
 */
function mockFetchFailThenSucceed(failCount: number) {
  let calls = 0;
  globalThis.fetch = vi.fn(async () => {
    calls++;
    if (calls <= failCount) {
      throw new Error('ECONNREFUSED');
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ok'
    } as Response;
  });
}

describe('PodController lifecycle hardening', () => {
  describe('readiness-gated status transitions', () => {
    it('stays in starting until readiness succeeds, then becomes running', async () => {
      let releaseHealthCheck: (() => void) | undefined;
      let callCount = 0;
      globalThis.fetch = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return new Promise<Response>((resolve) => {
          releaseHealthCheck = () => resolve({ ok: true, status: 200, statusText: 'OK' } as Response);
        });
      });

      const manifest = makeManifest({
        runtime: {
          kind: 'http-service',
          baseUrl: 'http://localhost:19876',
          submitPath: '/api/submit',
          healthPath: '/health',
          healthCheck: { timeoutMs: 2000, intervalMs: 10 }
        },
        startup: { command: 'echo started' }
      });

      const controller = new PodController([manifest]);
      const startPromise = controller.start(manifest);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(controller.getStatus(manifest.id)).toBe('starting');

      releaseHealthCheck?.();
      await startPromise;
      expect(controller.getStatus(manifest.id)).toBe('running');
    });

    it('returns to stopped when startup health checks never pass', async () => {
      mockUnhealthyFetch();

      const manifest = makeManifest({
        runtime: {
          kind: 'http-service',
          baseUrl: 'http://localhost:19876',
          submitPath: '/api/submit',
          healthPath: '/health',
          healthCheck: { timeoutMs: 100, intervalMs: 10 }
        },
        startup: { command: 'echo started' },
        shutdown: { command: 'echo rollback' }
      });

      const controller = new PodController([manifest]);
      await expect(controller.start(manifest)).rejects.toThrow('Health check did not pass');
      expect(controller.getStatus(manifest.id)).toBe('stopped');
    });
  });

  describe('lifecycle command timeout', () => {
    it('passes timeout to exec and succeeds within time', async () => {
      // Health check: first call fails (before start), second succeeds (after command)
      mockFetchFailThenSucceed(1);

      const manifest = makeManifestWithHealth({
        startup: {
          command: 'echo hello',
          timeoutMs: 5000
        }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);
      expect(controller.getStatus(manifest.id)).toBe('running');
    });

    it('fails if command exceeds timeout', async () => {
      // Health check always fails (won't matter, command will timeout first)
      mockUnhealthyFetch();

      const manifest = makeManifestWithHealth({
        startup: {
          command: 'sleep 10',
          timeoutMs: 100
        }
      });

      const controller = new PodController([manifest]);
      await expect(controller.start(manifest)).rejects.toThrow();
    });
  });

  describe('stdout/stderr capture', () => {
    it('captures stdout from lifecycle command', async () => {
      mockFetchFailThenSucceed(1);

      const manifest = makeManifestWithHealth({
        startup: {
          command: 'echo "startup output"'
        }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);

      const output = controller.getLastLifecycleOutput(manifest.id);
      expect(output).toBeDefined();
      expect(output!.stdout).toContain('startup output');
    });

    it('captures stderr from lifecycle command', async () => {
      mockFetchFailThenSucceed(1);

      const manifest = makeManifestWithHealth({
        startup: {
          command: 'echo "err msg" >&2'
        }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);

      const output = controller.getLastLifecycleOutput(manifest.id);
      expect(output).toBeDefined();
      expect(output!.stderr).toContain('err msg');
    });

    it('returns undefined if no command has been run', () => {
      const manifest = makeManifest();
      const controller = new PodController([manifest]);
      expect(controller.getLastLifecycleOutput(manifest.id)).toBeUndefined();
    });
  });

  describe('graceful shutdown degradation', () => {
    it('marks pod as stopped even if shutdown command fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // No healthPath — start() will skip command and just set running
      const manifest = makeManifest({
        startup: { command: 'echo start' },
        shutdown: { command: 'exit 1' }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);
      expect(controller.getStatus(manifest.id)).toBe('running');

      // Stop should NOT throw even though 'exit 1' fails
      await controller.stop(manifest);
      expect(controller.getStatus(manifest.id)).toBe('stopped');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('shutdown command failed for pod test-pod')
      );

      consoleSpy.mockRestore();
    });

    it('marks pod as stopped if shutdown command does not exist', async () => {
      const manifest = makeManifest({
        startup: { command: 'echo start' }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);
      await controller.stop(manifest);
      expect(controller.getStatus(manifest.id)).toBe('stopped');
    });
  });

  describe('configurable health check', () => {
    it('times out quickly with small healthCheck.timeoutMs', async () => {
      mockUnhealthyFetch();

      const manifest = makeManifest({
        startup: { command: 'echo started' },
        runtime: {
          kind: 'http-service',
          baseUrl: 'http://localhost:19876',
          submitPath: '/api/submit',
          healthPath: '/health',
          healthCheck: {
            timeoutMs: 100,
            intervalMs: 10
          }
        }
      });

      const controller = new PodController([manifest]);
      await expect(controller.start(manifest)).rejects.toThrow('Health check did not pass');
    });

    it('skips health check when no healthPath', async () => {
      const manifest = makeManifest({
        startup: { command: 'echo started' }
      });

      const controller = new PodController([manifest]);
      await controller.start(manifest);
      expect(controller.getStatus(manifest.id)).toBe('running');
    });
  });
});
