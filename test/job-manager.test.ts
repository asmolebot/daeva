import { describe, expect, it } from 'vitest';

import { JobValidationError, PodRequestError } from '../src/errors.js';
import { inferCapabilityForJobType } from '../src/job-contracts.js';
import type { JobRequest, PodManifest } from '../src/types.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import { testManifests } from './helpers.js';

class RecordingAdapter {
  readonly seen: Array<{ podId: string; type: string }> = [];

  async execute(manifest: PodManifest, request: JobRequest) {
    this.seen.push({ podId: manifest.id, type: request.type });
    return {
      status: 'succeeded' as const,
      pod: {
        id: manifest.id,
        nickname: manifest.nickname,
        runtime: manifest.runtime
      },
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
        raw: {
          ok: true,
          podId: manifest.id,
          type: request.type
        }
      }
    };
  }
}

class FailingAdapter {
  async execute(): Promise<never> {
    throw new PodRequestError('Upstream pod exploded usefully', {
      retriable: true,
      details: { status: 503, podId: 'whisper' }
    });
  }
}

describe('JobManager', () => {
  it('processes queued jobs in order and stores normalized results', async () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const adapter = new RecordingAdapter();
    const manager = new JobManager(registry, controller, router, { adapter });

    const first = manager.enqueue({
      type: 'generate-image',
      input: { prompt: 'witchy toaster' }
    });
    const second = manager.enqueue({
      type: 'ocr-document',
      input: {},
      files: [{ source: 'path', path: '/tmp/doc.png', filename: 'doc.png', contentType: 'image/png' }]
    });

    await manager.waitForIdle();

    expect(adapter.seen.map((entry) => entry.type)).toEqual(['generate-image', 'ocr-document']);
    expect(manager.getJob(first.id).status).toBe('completed');
    expect(manager.getJob(second.id).status).toBe('completed');
    expect(manager.getResult(second.id)).toMatchObject({
      status: 'succeeded',
      pod: { id: 'ocr-vision' },
      request: {
        capability: 'ocr',
        files: [{ source: 'path', filename: 'doc.png', contentType: 'image/png' }]
      }
    });
  });

  it('rejects invalid jobs up front with capability-specific validation', () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter: new RecordingAdapter() });

    expect(() =>
      manager.enqueue({
        type: 'generate-image',
        input: {}
      })
    ).toThrow(JobValidationError);
  });

  it('captures structured job failure payloads', async () => {
    const registry = new PodRegistry(testManifests());
    const controller = new PodController(registry.list());
    const router = new SchedulerRouter(registry, controller);
    const manager = new JobManager(registry, controller, router, { adapter: new FailingAdapter() });

    const job = manager.enqueue({
      type: 'transcribe-audio',
      input: {},
      files: [{ source: 'path', path: '/tmp/sample.wav', filename: 'sample.wav', contentType: 'audio/wav' }]
    });

    await manager.waitForIdle();

    expect(manager.getJob(job.id).status).toBe('failed');
    expect(manager.getJob(job.id).error).toEqual({
      code: 'POD_REQUEST_ERROR',
      message: 'Upstream pod exploded usefully',
      details: { status: 503, podId: 'whisper' },
      retriable: true
    });
    expect(manager.getResult(job.id)).toMatchObject({
      status: 'failed',
      output: {
        error: {
          code: 'POD_REQUEST_ERROR',
          retriable: true
        }
      }
    });
  });
});
