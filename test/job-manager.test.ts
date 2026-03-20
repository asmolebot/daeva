import { describe, expect, it } from 'vitest';

import type { JobRequest, PodManifest } from '../src/types.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';

class RecordingAdapter {
  readonly seen: Array<{ podId: string; type: string }> = [];

  async execute(manifest: PodManifest, request: JobRequest) {
    this.seen.push({ podId: manifest.id, type: request.type });
    return {
      ok: true,
      podId: manifest.id,
      type: request.type
    };
  }
}

describe('JobManager', () => {
  it('processes queued jobs in order and stores results', async () => {
    const registry = new PodRegistry();
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
      input: { imageUrl: 'file:///tmp/doc.png' }
    });

    await manager.waitForIdle();

    expect(adapter.seen.map((entry) => entry.type)).toEqual(['generate-image', 'ocr-document']);
    expect(manager.getJob(first.id).status).toBe('completed');
    expect(manager.getJob(second.id).status).toBe('completed');
    expect(manager.getResult(second.id)).toMatchObject({ ok: true, podId: 'ocr-vision' });
  });
});
