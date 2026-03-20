import type { JobRequest, PodManifest, RunContext } from './types.js';
import { sleep } from './utils.js';

export interface PodAdapter {
  execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<unknown>;
}

export class HttpPodAdapter implements PodAdapter {
  async execute(manifest: PodManifest, request: JobRequest): Promise<unknown> {
    await sleep(25);

    return {
      podId: manifest.id,
      capability: request.capability,
      acceptedAt: new Date().toISOString(),
      submitUrl: `${manifest.runtime.baseUrl}${manifest.runtime.submitPath}`,
      method: manifest.runtime.method ?? 'POST',
      payload: request.input,
      note: 'Stub adapter result. Replace with real HTTP transport + polling for production use.'
    };
  }
}
