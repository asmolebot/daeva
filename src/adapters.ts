import { AppError, PodRequestError } from './errors.js';
import type { HttpServiceRuntime, JobCompletedResult, JobRequest, PodManifest, RetryConfig, RunContext } from './types.js';
import {
  buildAdapterRequest,
  inferCapabilityForJobType,
  normalizeCompletedResult,
  wrapJobExecutionError,
  wrapPodRequestError
} from './job-contracts.js';
import { sleep } from './utils.js';

export interface PodAdapter {
  execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<JobCompletedResult>;
}

/** Default retry config used when no per-manifest override is set. */
export const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLLING_INTERVAL_MS = 2_000;
const DEFAULT_POLLING_TIMEOUT_MS = 300_000;

export interface HttpPodAdapterOptions {
  /** Global default retry config; per-manifest overrides take precedence. */
  retry?: RetryConfig;
  /** Global default request timeout in ms; per-manifest overrides take precedence. */
  requestTimeoutMs?: number;
}

/** Compute exponential backoff delay with jitter. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * 2 ** attempt;
  const clamped = Math.min(exponential, maxMs);
  // Add up to 25% jitter
  return clamped + Math.random() * clamped * 0.25;
}

/** Fetch a URL with an independent timeout (AbortController), layered on top of the context signal. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  contextSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();

  // If the caller already aborted, abort immediately.
  if (contextSignal?.aborted) {
    controller.abort(contextSignal.reason);
  }

  // Forward context signal abort to our controller.
  const onContextAbort = () => controller.abort(contextSignal?.reason);
  contextSignal?.addEventListener('abort', onContextAbort, { once: true });

  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    contextSignal?.removeEventListener('abort', onContextAbort);
  }
}

/** Parse response body to text then attempt JSON parse. */
async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Determine if an error/response is retriable. */
function isRetriable(error: unknown): boolean {
  if (error instanceof PodRequestError) {
    return error.retriable ?? false;
  }
  if (error instanceof AppError) {
    return false;
  }
  // Network errors (fetch failures, timeouts) are retriable.
  return true;
}

export class HttpPodAdapter implements PodAdapter {
  private readonly globalRetry: Required<RetryConfig>;
  private readonly globalTimeoutMs: number;

  constructor(options: HttpPodAdapterOptions = {}) {
    this.globalRetry = {
      maxRetries: options.retry?.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs
    };
    this.globalTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async execute(manifest: PodManifest, request: JobRequest, context?: RunContext): Promise<JobCompletedResult> {
    if (manifest.runtime.kind !== 'http-service') {
      throw new AppError(
        `HttpPodAdapter cannot handle runtime kind "${manifest.runtime.kind}" for pod ${manifest.id}`,
        { code: 'ADAPTER_RUNTIME_MISMATCH', type: 'internal', retriable: false }
      );
    }

    const runtime = manifest.runtime as HttpServiceRuntime;
    const url = `${runtime.baseUrl}${runtime.submitPath}`;
    const method = runtime.method ?? 'POST';
    const capability = request.capability ?? inferCapabilityForJobType(request.type);

    const retryConfig = {
      maxRetries: runtime.retry?.maxRetries ?? this.globalRetry.maxRetries,
      baseDelayMs: runtime.retry?.baseDelayMs ?? this.globalRetry.baseDelayMs,
      maxDelayMs: runtime.retry?.maxDelayMs ?? this.globalRetry.maxDelayMs
    };
    const timeoutMs = runtime.requestTimeoutMs ?? this.globalTimeoutMs;

    try {
      const built = await buildAdapterRequest(request);
      const init: RequestInit = {
        ...built,
        method
      };

      const parsed = await this.executeWithRetry(url, init, timeoutMs, retryConfig, manifest, context);

      // If resultPath is defined, poll for async result.
      const finalResponse = runtime.resultPath
        ? await this.pollForResult(runtime, timeoutMs, manifest, context)
        : parsed;

      return normalizeCompletedResult(manifest, request, capability, {
        acceptedAt: new Date().toISOString(),
        submitUrl: url,
        method,
        bodyKind: built.bodyKind,
        response: finalResponse
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw wrapJobExecutionError(manifest, error);
    }
  }

  /** Execute a fetch with retry logic and timeout. */
  private async executeWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    retryConfig: Required<RetryConfig>,
    manifest: PodManifest,
    context?: RunContext
  ): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        const response = await fetchWithTimeout(url, init, timeoutMs, context?.signal);
        const parsed = await parseResponseBody(response);

        if (!response.ok) {
          const err = wrapPodRequestError(manifest, response.status, response.statusText, parsed);
          if (!isRetriable(err) || attempt >= retryConfig.maxRetries) {
            throw err;
          }
          lastError = err;
          await sleep(backoffDelay(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs));
          continue;
        }

        return parsed;
      } catch (error) {
        if (error instanceof AppError && !isRetriable(error)) {
          throw error;
        }
        lastError = error;
        if (attempt >= retryConfig.maxRetries) {
          break;
        }
        await sleep(backoffDelay(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs));
      }
    }

    // All retries exhausted.
    if (lastError instanceof AppError) {
      throw lastError;
    }
    throw wrapJobExecutionError(manifest, lastError);
  }

  /** Poll resultPath for an async job until it returns a terminal state or times out. */
  private async pollForResult(
    runtime: HttpServiceRuntime,
    requestTimeoutMs: number,
    manifest: PodManifest,
    context?: RunContext
  ): Promise<unknown> {
    const resultUrl = `${runtime.baseUrl}${runtime.resultPath}`;
    const intervalMs = runtime.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    const pollingTimeoutMs = runtime.pollingTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS;
    const deadline = Date.now() + pollingTimeoutMs;

    while (Date.now() < deadline) {
      if (context?.signal?.aborted) {
        throw new AppError('Polling aborted', { code: 'POLLING_ABORTED', type: 'job-execution', retriable: false });
      }

      await sleep(intervalMs);

      try {
        const response = await fetchWithTimeout(resultUrl, { method: 'GET' }, requestTimeoutMs, context?.signal);
        const parsed = await parseResponseBody(response);

        if (!response.ok) {
          // 404 or 202 means not ready yet — keep polling.
          if (response.status === 404 || response.status === 202) {
            continue;
          }
          throw wrapPodRequestError(manifest, response.status, response.statusText, parsed);
        }

        // Check if the response indicates completion.
        if (isPollingComplete(parsed)) {
          return parsed;
        }
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        // Transient fetch error during polling — keep trying until deadline.
      }
    }

    throw new AppError(`Polling timed out for pod ${manifest.id} at ${resultUrl}`, {
      code: 'POLLING_TIMEOUT',
      type: 'job-execution',
      retriable: true,
      details: { podId: manifest.id, resultUrl, pollingTimeoutMs }
    });
  }
}

/** Determine if a polled response represents a completed job. */
function isPollingComplete(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) {
    // Non-object 2xx responses are considered complete.
    return true;
  }
  const record = parsed as Record<string, unknown>;
  // Check for explicit status fields that indicate pending/running.
  if ('status' in record) {
    const status = String(record.status).toLowerCase();
    if (status === 'pending' || status === 'running' || status === 'queued' || status === 'processing') {
      return false;
    }
  }
  return true;
}
