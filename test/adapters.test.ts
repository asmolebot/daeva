import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpPodAdapter, backoffDelay, DEFAULT_RETRY } from '../src/adapters.js';
import type { HttpServiceRuntime, PodManifest, JobRequest } from '../src/types.js';
import { AppError, PodRequestError } from '../src/errors.js';

const makeManifest = (overrides: Partial<HttpServiceRuntime> = {}, manifestOverrides: Partial<PodManifest> = {}): PodManifest => ({
  id: 'test-pod',
  nickname: 'Test Pod',
  description: 'A test pod',
  capabilities: ['image-generation'],
  source: {},
  runtime: {
    kind: 'http-service',
    baseUrl: 'http://localhost:9999',
    submitPath: '/api/submit',
    method: 'POST',
    ...overrides
  },
  ...manifestOverrides
});

const makeRequest = (): JobRequest => ({
  type: 'generate-image',
  input: { prompt: 'a cat' }
});

function mockFetch(responses: Array<{ ok: boolean; status: number; statusText: string; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[Math.min(callIndex++, responses.length - 1)];
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      text: async () => typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
    } as Response;
  });
}

describe('backoffDelay', () => {
  it('returns a value between baseMs*2^attempt and that value * 1.25', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = backoffDelay(attempt, 500, 10_000);
      const base = Math.min(500 * 2 ** attempt, 10_000);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it('clamps to maxMs', () => {
    const delay = backoffDelay(20, 500, 1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });
});

describe('HttpPodAdapter', () => {
  let originalFetch: typeof globalThis.fetch;
  let tempDir: string;

  const makeComfyManifest = (workflowPath?: string): PodManifest => makeManifest(
    {
      baseUrl: 'http://localhost:8188',
      submitPath: '/prompt',
      healthPath: '/system_stats',
      pollingIntervalMs: 10,
      pollingTimeoutMs: 1000
    },
    {
      id: 'comfyapi',
      metadata: workflowPath
        ? {
            workflow: {
              workflowPath,
              promptNodeId: '2',
              promptInputName: 'text',
              outputNodeId: '7'
            }
          }
        : undefined
    }
  );

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'daeva-adapters-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('basic execution', () => {
    it('sends request and normalizes response', async () => {
      globalThis.fetch = mockFetch([{
        ok: true,
        status: 200,
        statusText: 'OK',
        body: { images: [{ url: 'http://example.com/img.png', width: 512, height: 512 }] }
      }]);

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const result = await adapter.execute(makeManifest(), makeRequest());

      expect(result.status).toBe('succeeded');
      expect(result.output.kind).toBe('image-generation');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws on runtime mismatch', async () => {
      const adapter = new HttpPodAdapter();
      const manifest = { ...makeManifest(), runtime: { kind: 'rpod' as const, host: 'foo' } };
      await expect(adapter.execute(manifest, makeRequest())).rejects.toThrow('cannot handle runtime kind');
    });
  });

  describe('retry logic', () => {
    it('retries on 500 errors with exponential backoff', async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 500, statusText: 'Internal Server Error', body: { error: 'boom' } },
        { ok: false, status: 502, statusText: 'Bad Gateway', body: { error: 'upstream' } },
        { ok: true, status: 200, statusText: 'OK', body: { images: [{ url: 'http://x.com/img.png' }] } }
      ]);

      const adapter = new HttpPodAdapter({
        retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 }
      });
      const result = await adapter.execute(makeManifest(), makeRequest());

      expect(result.status).toBe('succeeded');
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry 4xx errors', async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 400, statusText: 'Bad Request', body: { error: 'invalid' } }
      ]);

      const adapter = new HttpPodAdapter({
        retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 }
      });

      await expect(adapter.execute(makeManifest(), makeRequest())).rejects.toThrow(PodRequestError);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws last error', async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 500, statusText: 'Error', body: {} },
        { ok: false, status: 500, statusText: 'Error', body: {} },
        { ok: false, status: 500, statusText: 'Error', body: {} }
      ]);

      const adapter = new HttpPodAdapter({
        retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }
      });

      await expect(adapter.execute(makeManifest(), makeRequest())).rejects.toThrow(PodRequestError);
      // initial attempt + 2 retries
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('retries on network errors (fetch throw)', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls <= 2) throw new Error('ECONNREFUSED');
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ images: [{ url: 'http://x.com/img.png' }] })
        } as Response;
      });

      const adapter = new HttpPodAdapter({
        retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 }
      });
      const result = await adapter.execute(makeManifest(), makeRequest());
      expect(result.status).toBe('succeeded');
      expect(calls).toBe(3);
    });

    it('uses per-manifest retry config', async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 500, statusText: 'Error', body: {} },
        { ok: true, status: 200, statusText: 'OK', body: { images: [{ url: 'http://x.com/a.png' }] } }
      ]);

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const manifest = makeManifest({ retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 } });
      const result = await adapter.execute(manifest, makeRequest());

      expect(result.status).toBe('succeeded');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('comfy workflow execution', () => {
    it('injects prompt into workflow, posts Comfy payload, and resolves history output', async () => {
      const workflowPath = path.join(tempDir, 'text-to-image.json');
      writeFileSync(workflowPath, JSON.stringify({
        '2': { inputs: { text: 'old prompt' }, class_type: 'CLIPTextEncode' },
        '7': { inputs: { images: ['6', 0] }, class_type: 'SaveImage' }
      }));

      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/prompt')) {
          const payload = JSON.parse(String(init?.body)) as { prompt: Record<string, { inputs: Record<string, unknown> }>; client_id: string };
          expect(payload.prompt['2'].inputs.text).toBe('summon a tasteful demon');
          expect(typeof payload.client_id).toBe('string');
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ prompt_id: 'prompt-123' })
          } as Response;
        }

        if (urlStr.endsWith('/history/prompt-123')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({
              'prompt-123': {
                outputs: {
                  '7': {
                    images: [{ filename: 'out.png', subfolder: '', type: 'output' }]
                  }
                }
              }
            })
          } as Response;
        }

        throw new Error(`unexpected url: ${urlStr}`);
      });
      globalThis.fetch = fetchMock;

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const result = await adapter.execute(makeComfyManifest(workflowPath), {
        type: 'generate-image',
        input: { prompt: 'summon a tasteful demon' }
      });

      expect(result.status).toBe('succeeded');
      expect(result.output.kind).toBe('image-generation');
      if (result.output.kind !== 'image-generation') throw new Error('expected image-generation output');
      expect(result.output.generatedImages?.[0]?.url).toContain('/view?filename=out.png');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails clearly when comfy workflow metadata is missing', async () => {
      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });

      await expect(adapter.execute(makeComfyManifest(), makeRequest())).rejects.toMatchObject({
        code: 'COMFY_WORKFLOW_CONFIG_MISSING'
      });
    });

    it('fails clearly when workflow path cannot be loaded', async () => {
      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });

      await expect(adapter.execute(makeComfyManifest(path.join(tempDir, 'missing.json')), makeRequest())).rejects.toMatchObject({
        code: 'COMFY_WORKFLOW_LOAD_FAILED'
      });
    });

    it('fails clearly when Comfy does not return prompt_id', async () => {
      const workflowPath = path.join(tempDir, 'text-to-image.json');
      writeFileSync(workflowPath, JSON.stringify({
        '2': { inputs: { text: 'old prompt' }, class_type: 'CLIPTextEncode' }
      }));

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ queued: true })
      } as Response));

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      await expect(adapter.execute(makeComfyManifest(workflowPath), makeRequest())).rejects.toMatchObject({
        code: 'COMFY_PROMPT_ID_MISSING'
      });
    });
  });

  describe('request timeout', () => {
    it('times out slow requests via AbortController', async () => {
      globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(signal.reason);
          });
        });
      });

      const adapter = new HttpPodAdapter({
        requestTimeoutMs: 50,
        retry: { maxRetries: 0 }
      });

      await expect(adapter.execute(makeManifest(), makeRequest())).rejects.toThrow();
    });

    it('uses per-manifest requestTimeoutMs', async () => {
      globalThis.fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(signal.reason);
          });
        });
      });

      const adapter = new HttpPodAdapter({
        requestTimeoutMs: 60_000,
        retry: { maxRetries: 0 }
      });
      const manifest = makeManifest({ requestTimeoutMs: 50 });

      await expect(adapter.execute(manifest, makeRequest())).rejects.toThrow();
    });
  });

  describe('async polling', () => {
    it('polls resultPath until job is complete', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        callCount++;
        const urlStr = String(url);
        if (urlStr.includes('/api/submit')) {
          return {
            ok: true, status: 202, statusText: 'Accepted',
            text: async () => JSON.stringify({ jobId: '123', status: 'queued' })
          } as Response;
        }
        if (urlStr.includes('/api/result')) {
          // callCount 2 and 3 are pending polls, callCount 4 is done
          if (callCount <= 3) {
            return {
              ok: true, status: 200, statusText: 'OK',
              text: async () => JSON.stringify({ status: 'processing' })
            } as Response;
          }
          return {
            ok: true, status: 200, statusText: 'OK',
            text: async () => JSON.stringify({ status: 'done', images: [{ url: 'http://x.com/final.png' }] })
          } as Response;
        }
        throw new Error(`unexpected url: ${urlStr}`);
      });

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const manifest = makeManifest({
        resultPath: '/api/result',
        pollingIntervalMs: 10,
        pollingTimeoutMs: 5000
      });

      const result = await adapter.execute(manifest, makeRequest());
      expect(result.status).toBe('succeeded');
      // submit(1) + polling calls(2 pending + 1 done) = 4
      expect(callCount).toBe(4);
    });

    it('times out polling when deadline exceeded', async () => {
      globalThis.fetch = vi.fn(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/submit')) {
          return {
            ok: true, status: 202, statusText: 'Accepted',
            text: async () => JSON.stringify({ jobId: '123' })
          } as Response;
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          text: async () => JSON.stringify({ status: 'processing' })
        } as Response;
      });

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const manifest = makeManifest({
        resultPath: '/api/result',
        pollingIntervalMs: 10,
        pollingTimeoutMs: 80
      });

      await expect(adapter.execute(manifest, makeRequest())).rejects.toThrow('Polling timed out');
    });

    it('handles 404 during polling as not-ready', async () => {
      let pollCount = 0;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        const urlStr = String(url);
        if (urlStr.includes('/api/submit')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            text: async () => JSON.stringify({ accepted: true })
          } as Response;
        }
        pollCount++;
        if (pollCount <= 2) {
          return {
            ok: false, status: 404, statusText: 'Not Found',
            text: async () => 'not found'
          } as Response;
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          text: async () => JSON.stringify({ status: 'completed', images: [{ url: 'http://x.com/a.png' }] })
        } as Response;
      });

      const adapter = new HttpPodAdapter({ retry: { maxRetries: 0 } });
      const manifest = makeManifest({
        resultPath: '/api/result',
        pollingIntervalMs: 10,
        pollingTimeoutMs: 5000
      });

      const result = await adapter.execute(manifest, makeRequest());
      expect(result.status).toBe('succeeded');
    });
  });
});
