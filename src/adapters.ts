import { AppError } from './errors.js';
import type { JobCompletedResult, JobRequest, PodManifest, RunContext } from './types.js';
import {
  buildAdapterRequest,
  inferCapabilityForJobType,
  normalizeCompletedResult,
  wrapJobExecutionError,
  wrapPodRequestError
} from './job-contracts.js';

export interface PodAdapter {
  execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<JobCompletedResult>;
}

export class HttpPodAdapter implements PodAdapter {
  async execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<JobCompletedResult> {
    if (manifest.runtime.kind !== 'http-service') {
      throw new AppError(
        `HttpPodAdapter cannot handle runtime kind "${manifest.runtime.kind}" for pod ${manifest.id}`,
        { code: 'ADAPTER_RUNTIME_MISMATCH', type: 'internal', retriable: false }
      );
    }
    const url = `${manifest.runtime.baseUrl}${manifest.runtime.submitPath}`;
    const method = manifest.runtime.method ?? 'POST';
    const capability = request.capability ?? inferCapabilityForJobType(request.type);

    try {
      const built = await buildAdapterRequest(request);
      const init: RequestInit = {
        ...built,
        method,
        signal: context?.signal
      };

      const response = await fetch(url, init);
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }

      if (!response.ok) {
        throw wrapPodRequestError(manifest, response.status, response.statusText, parsed);
      }

      return normalizeCompletedResult(manifest, request, capability, {
        acceptedAt: new Date().toISOString(),
        submitUrl: url,
        method,
        bodyKind: built.bodyKind,
        response: parsed
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw wrapJobExecutionError(manifest, error);
    }
  }
}
