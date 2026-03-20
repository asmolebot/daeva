import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server.js';

const { app, jobManager } = buildApp();

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
        input: { audioUrl: 'file:///tmp/demo.wav' }
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
