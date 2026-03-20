import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import type { JobRequest, PodManifest } from '../src/types.js';
import { testManifests } from './helpers.js';

class RecordingAdapter {
  async execute(manifest: PodManifest, request: JobRequest) {
    return {
      ok: true,
      podId: manifest.id,
      type: request.type,
      echoedInput: request.input
    };
  }
}

const registry = new PodRegistry(testManifests());
const podController = new PodController(registry.list());
const router = new SchedulerRouter(registry, podController);
const jobManager = new JobManager(registry, podController, router, {
  adapter: new RecordingAdapter()
});
const { app } = buildApp({ registry, podController, router, jobManager });

afterAll(async () => {
  await app.close();
});

describe('HTTP API', () => {
  it('lists builtin pods', async () => {
    const response = await app.inject({ method: 'GET', url: '/pods' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pods).toHaveLength(3);
  });

  it('accepts a job and exposes its result', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'transcribe-audio',
        input: { text: 'demo' }
      }
    });

    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json();
    await jobManager.waitForIdle();

    const jobResponse = await app.inject({ method: 'GET', url: `/jobs/${created.job.id}` });
    const resultResponse = await app.inject({ method: 'GET', url: `/jobs/${created.job.id}/result` });

    expect(jobResponse.statusCode).toBe(200);
    expect(jobResponse.json().job.status).toBe('completed');
    expect(resultResponse.statusCode).toBe(200);
    expect(resultResponse.json().result.podId).toBe('whisper');
  });
});
