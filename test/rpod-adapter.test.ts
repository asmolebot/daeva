import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  clearRpodPodId,
  executeViaRpod,
  getRpodPodId,
  rpodDiscover,
  rpodExec,
  rpodIsRunning,
  rpodPs,
  rpodRun,
  rpodStop,
  setRpodPodId
} from '../src/rpod-adapter.js';
import type { PodManifest, RpodRuntime } from '../src/types.js';
import { AppError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRpodRuntime = (overrides: Partial<RpodRuntime> = {}): RpodRuntime => ({
  kind: 'rpod',
  command: 'rpod',
  host: 'gpu-host-1',
  device: 'gpu:0',
  ...overrides
});

const makeRpodManifest = (overrides: Partial<PodManifest> = {}): PodManifest => ({
  id: 'test-rpod-pod',
  nickname: 'Test RPOD Pod',
  description: 'A test pod using rpod runtime',
  capabilities: ['image-generation'],
  source: { homepage: 'https://example.com' },
  runtime: makeRpodRuntime(),
  ...overrides
});

// ---------------------------------------------------------------------------
// Module-level exec mock
// ---------------------------------------------------------------------------

// We mock 'node:child_process' at the module level so rpod-adapter picks it up
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    exec: vi.fn()
  };
});

const getExecMock = async () => {
  const mod = await import('node:child_process');
  return vi.mocked(mod.exec) as ReturnType<typeof vi.fn>;
};

// Helper: make exec call the promisified callback style
function mockExecResult(execMock: ReturnType<typeof vi.fn>, stdout: string, stderr = '') {
  execMock.mockImplementationOnce((_cmd: string, _opts: unknown, callback: Function) => {
    // promisify passes callback as last arg
    callback(null, { stdout, stderr });
  });
}

function mockExecError(execMock: ReturnType<typeof vi.fn>, message: string) {
  execMock.mockImplementationOnce((_cmd: string, _opts: unknown, callback: Function) => {
    callback(new Error(message));
  });
}

// ---------------------------------------------------------------------------
// pod-id store tests
// ---------------------------------------------------------------------------

describe('rpod pod-id store', () => {
  beforeEach(() => {
    clearRpodPodId('test-pod');
  });

  it('stores, retrieves and clears a pod-id', () => {
    expect(getRpodPodId('test-pod')).toBeUndefined();
    setRpodPodId('test-pod', 'remote-abc-123');
    expect(getRpodPodId('test-pod')).toBe('remote-abc-123');
    clearRpodPodId('test-pod');
    expect(getRpodPodId('test-pod')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rpodRun tests
// ---------------------------------------------------------------------------

describe('rpodRun', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns pod-id from JSON stdout', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify({ podId: 'remote-pod-xyz' }));

    const runtime = makeRpodRuntime();
    const podId = await rpodRun(runtime);
    expect(podId).toBe('remote-pod-xyz');
  });

  it('also accepts "id" field instead of "podId"', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify({ id: 'remote-pod-456' }));

    const podId = await rpodRun(makeRpodRuntime());
    expect(podId).toBe('remote-pod-456');
  });

  it('throws RPOD_NO_POD_ID when no pod-id in response', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify({ status: 'ok' }));

    await expect(rpodRun(makeRpodRuntime())).rejects.toMatchObject({
      code: 'RPOD_NO_POD_ID'
    });
  });

  it('uses custom command binary', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify({ podId: 'p1' }));

    await rpodRun(makeRpodRuntime({ command: '/usr/local/bin/rpod' }));

    const calledCmd = execMock.mock.calls[0][0] as string;
    expect(calledCmd).toContain('/usr/local/bin/rpod');
  });

  it('includes --device arg when device is set', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify({ podId: 'p2' }));

    await rpodRun(makeRpodRuntime({ device: 'cuda:1' }));

    const calledCmd = execMock.mock.calls[0][0] as string;
    expect(calledCmd).toContain('--device');
    expect(calledCmd).toContain('cuda:1');
  });
});

// ---------------------------------------------------------------------------
// rpodStop tests
// ---------------------------------------------------------------------------

describe('rpodStop', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls rpod stop with host and pod-id', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, '');

    await rpodStop(makeRpodRuntime(), 'remote-pod-abc');

    const calledCmd = execMock.mock.calls[0][0] as string;
    expect(calledCmd).toContain('stop');
    expect(calledCmd).toContain('gpu-host-1');
    expect(calledCmd).toContain('remote-pod-abc');
  });

  it('propagates CLI error as RPOD_CLI_ERROR', async () => {
    const execMock = await getExecMock();
    mockExecError(execMock, 'connection refused');

    await expect(rpodStop(makeRpodRuntime(), 'pod-x')).rejects.toMatchObject({
      code: 'RPOD_CLI_ERROR'
    });
  });
});

// ---------------------------------------------------------------------------
// rpodExec tests
// ---------------------------------------------------------------------------

describe('rpodExec', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns stdout from exec command', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, 'exec output');

    const out = await rpodExec(makeRpodRuntime(), 'pod-123', 'echo hello');
    expect(out).toBe('exec output');
  });

  it('includes env vars in command when execOptions.env is set', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, '');

    const runtime = makeRpodRuntime({ execOptions: { env: { MY_VAR: 'hello' } } });
    await rpodExec(runtime, 'pod-1', 'do-something');

    const calledCmd = execMock.mock.calls[0][0] as string;
    expect(calledCmd).toContain('MY_VAR=hello');
  });
});

// ---------------------------------------------------------------------------
// rpodPs / rpodDiscover tests
// ---------------------------------------------------------------------------

describe('rpodPs', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns parsed list of running pods', async () => {
    const execMock = await getExecMock();
    const entries = [{ podId: 'p1', host: 'gpu-host-1', status: 'running' }];
    mockExecResult(execMock, JSON.stringify(entries));

    const result = await rpodPs(makeRpodRuntime());
    expect(result).toEqual(entries);
  });

  it('returns empty array on parse failure', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, 'not-json');

    const result = await rpodPs(makeRpodRuntime());
    expect(result).toEqual([]);
  });
});

describe('rpodDiscover', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns parsed discover entries', async () => {
    const execMock = await getExecMock();
    const entries = [{ host: 'gpu-host-1', device: 'gpu:0', status: 'available' }];
    mockExecResult(execMock, JSON.stringify(entries));

    const result = await rpodDiscover(makeRpodRuntime());
    expect(result).toEqual(entries);
  });
});

// ---------------------------------------------------------------------------
// rpodIsRunning tests
// ---------------------------------------------------------------------------

describe('rpodIsRunning', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns true when pod-id is running', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify([{ podId: 'p1', host: 'gpu-host-1', status: 'running' }]));

    const running = await rpodIsRunning(makeRpodRuntime(), 'p1');
    expect(running).toBe(true);
  });

  it('returns false when pod not in ps output', async () => {
    const execMock = await getExecMock();
    mockExecResult(execMock, JSON.stringify([]));

    const running = await rpodIsRunning(makeRpodRuntime(), 'missing-pod');
    expect(running).toBe(false);
  });

  it('returns false on CLI error (graceful)', async () => {
    const execMock = await getExecMock();
    mockExecError(execMock, 'network error');

    const running = await rpodIsRunning(makeRpodRuntime(), 'any-pod');
    expect(running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeViaRpod tests
// ---------------------------------------------------------------------------

describe('executeViaRpod', () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearRpodPodId('test-rpod-pod');
  });

  it('throws RPOD_NOT_STARTED when no pod-id is stored', async () => {
    const manifest = makeRpodManifest();
    await expect(executeViaRpod(manifest, { type: 'generate-image', input: { prompt: 'test' } }))
      .rejects.toMatchObject({ code: 'RPOD_NOT_STARTED' });
  });

  it('executes and normalizes a successful job result', async () => {
    const execMock = await getExecMock();
    const fakeResponse = { images: [{ url: 'http://host/out.png' }] };
    mockExecResult(execMock, JSON.stringify(fakeResponse));

    const manifest = makeRpodManifest();
    setRpodPodId(manifest.id, 'remote-pod-99');

    const result = await executeViaRpod(manifest, {
      type: 'generate-image',
      capability: 'image-generation',
      input: { prompt: 'a glowing demon' }
    });

    expect(result.status).toBe('succeeded');
    expect(result.pod?.id).toBe('test-rpod-pod');
    expect(result.pod?.runtime.kind).toBe('rpod');
  });
});
