import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError, PodRequestError } from './errors.js';
import type { ComfyWorkflowConfig, HttpServiceRuntime, JobCompletedResult, JobRequest, PodManifest, RetryConfig, RunContext } from './types.js';
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

type ComfyWorkflowGraph = Record<string, { inputs?: Record<string, unknown>; class_type?: string; _meta?: Record<string, unknown> }>;

interface ComfySubmitResponse {
  prompt_id?: string;
  number?: number;
  node_errors?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ComfyHistoryImage {
  filename?: string;
  subfolder?: string;
  type?: string;
  [key: string]: unknown;
}

interface ComfyExecutionPayload {
  prompt: ComfyWorkflowGraph;
  client_id: string;
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

  if (contextSignal?.aborted) {
    controller.abort(contextSignal.reason);
  }

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

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRetriable(error: unknown): boolean {
  if (error instanceof PodRequestError) {
    return error.retriable ?? false;
  }
  if (error instanceof AppError) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isComfyManifest(manifest: PodManifest, capability: string): boolean {
  if (capability !== 'image-generation') return false;
  if (manifest.runtime.kind !== 'http-service') return false;
  if (getComfyWorkflowConfig(manifest)) return true;
  return manifest.runtime.submitPath === '/prompt' && manifest.runtime.healthPath === '/system_stats';
}

function getComfyWorkflowConfig(manifest: PodManifest): ComfyWorkflowConfig | undefined {
  if (!isRecord(manifest.metadata)) return undefined;
  const workflow = isRecord(manifest.metadata.workflow) ? manifest.metadata.workflow : undefined;
  if (!workflow) return undefined;

  const promptNodeId = hasNonEmptyString(workflow.promptNodeId) ? workflow.promptNodeId : undefined;
  if (!promptNodeId) return undefined;

  return {
    path: hasNonEmptyString(workflow.path) ? workflow.path : undefined,
    workflowPath: hasNonEmptyString(workflow.workflowPath) ? workflow.workflowPath : undefined,
    promptNodeId,
    promptInputName: hasNonEmptyString(workflow.promptInputName) ? workflow.promptInputName : undefined,
    outputNodeId: hasNonEmptyString(workflow.outputNodeId) ? workflow.outputNodeId : undefined,
    inputImageNodeId: hasNonEmptyString(workflow.inputImageNodeId) ? workflow.inputImageNodeId : undefined,
    inputImageInputName: hasNonEmptyString(workflow.inputImageInputName) ? workflow.inputImageInputName : undefined
  };
}

function resolveWorkflowPath(manifest: PodManifest, workflow: ComfyWorkflowConfig): string | undefined {
  const configuredPath = workflow.workflowPath ?? workflow.path;
  if (!configuredPath) return undefined;
  if (path.isAbsolute(configuredPath)) return configuredPath;

  const metadata = isRecord(manifest.metadata) ? manifest.metadata : undefined;
  const templateContext = isRecord(metadata?.resolvedTemplateContext)
    ? metadata.resolvedTemplateContext
    : isRecord(metadata?.templateContext)
      ? metadata.templateContext
      : undefined;
  const packageDir = hasNonEmptyString(templateContext?.PACKAGE_DIR)
    ? templateContext.PACKAGE_DIR
    : hasNonEmptyString(metadata?.materializedPath)
      ? String(metadata.materializedPath)
      : undefined;

  return packageDir ? path.resolve(packageDir, configuredPath) : undefined;
}

async function loadComfyWorkflow(manifest: PodManifest): Promise<{ config: ComfyWorkflowConfig; workflowPath: string; graph: ComfyWorkflowGraph }> {
  const config = getComfyWorkflowConfig(manifest);
  if (!config) {
    throw new AppError(`Comfy pod ${manifest.id} is missing workflow metadata. Set metadata.workflow.workflowPath/path plus promptNodeId.`, {
      code: 'COMFY_WORKFLOW_CONFIG_MISSING',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id }
    });
  }

  const workflowPath = resolveWorkflowPath(manifest, config);
  if (!workflowPath) {
    throw new AppError(`Comfy pod ${manifest.id} does not expose a resolvable workflow path. Persist PACKAGE_DIR or use an absolute metadata.workflow path.`, {
      code: 'COMFY_WORKFLOW_PATH_UNRESOLVABLE',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id, workflowPath: config.workflowPath ?? config.path }
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(workflowPath, 'utf8'));
  } catch (error) {
    throw new AppError(`Unable to load Comfy workflow for pod ${manifest.id} from ${workflowPath}`, {
      code: 'COMFY_WORKFLOW_LOAD_FAILED',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id, workflowPath, cause: error instanceof Error ? error.message : String(error) }
    });
  }

  if (!isRecord(parsed)) {
    throw new AppError(`Comfy workflow for pod ${manifest.id} must be a JSON object graph`, {
      code: 'COMFY_WORKFLOW_INVALID',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id, workflowPath }
    });
  }

  return { config, workflowPath, graph: JSON.parse(JSON.stringify(parsed)) as ComfyWorkflowGraph };
}

function buildComfyExecutionPayload(manifest: PodManifest, request: JobRequest, loaded: { config: ComfyWorkflowConfig; workflowPath: string; graph: ComfyWorkflowGraph }): ComfyExecutionPayload {
  const prompt = request.input.prompt;
  if (!hasNonEmptyString(prompt)) {
    throw new AppError('Comfy image-generation jobs require input.prompt', {
      code: 'COMFY_PROMPT_REQUIRED',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id }
    });
  }

  const promptNodeId = loaded.config.promptNodeId;
  const promptInputName = loaded.config.promptInputName ?? 'text';
  const promptNode = loaded.graph[promptNodeId];
  if (!promptNode || !isRecord(promptNode.inputs)) {
    throw new AppError(`Comfy workflow for pod ${manifest.id} is missing prompt node ${promptNodeId}`, {
      code: 'COMFY_PROMPT_NODE_MISSING',
      type: 'validation',
      statusCode: 400,
      retriable: false,
      details: { podId: manifest.id, workflowPath: loaded.workflowPath, promptNodeId }
    });
  }

  promptNode.inputs[promptInputName] = prompt;

  return {
    prompt: loaded.graph,
    client_id: randomUUID()
  };
}

function extractPromptId(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  return hasNonEmptyString(parsed.prompt_id) ? parsed.prompt_id : undefined;
}

function buildComfyOutputFiles(baseUrl: string, images: ComfyHistoryImage[]) {
  return images.flatMap((image) => {
    if (!hasNonEmptyString(image.filename)) return [];
    const params = new URLSearchParams({ filename: image.filename });
    if (hasNonEmptyString(image.subfolder)) params.set('subfolder', image.subfolder);
    if (hasNonEmptyString(image.type)) params.set('type', image.type);

    return [{
      url: `${baseUrl}/view?${params.toString()}`,
      filename: image.filename,
      metadata: {
        subfolder: image.subfolder,
        type: image.type
      }
    }];
  });
}

function extractComfyImages(historyEntry: unknown, outputNodeId?: string): ComfyHistoryImage[] {
  if (!isRecord(historyEntry) || !isRecord(historyEntry.outputs)) return [];

  const nodes = outputNodeId
    ? [historyEntry.outputs[outputNodeId]]
    : Object.values(historyEntry.outputs);

  return nodes.flatMap((node) => {
    if (!isRecord(node) || !Array.isArray(node.images)) return [];
    return node.images.filter(isRecord) as ComfyHistoryImage[];
  });
}

function isComfyHistoryPending(parsed: unknown, promptId: string): boolean {
  if (!isRecord(parsed)) return true;
  const record = parsed[promptId];
  if (!record) return true;
  if (!isRecord(record)) return false;
  const status = isRecord(record.status) ? record.status : undefined;
  const statusString = hasNonEmptyString(status?.status_str) ? status.status_str.toLowerCase() : undefined;
  if (statusString && ['error', 'execution_error'].includes(statusString)) return false;
  return !isRecord(record.outputs);
}

function buildComfyResult(runtime: HttpServiceRuntime, promptId: string, historyEntry: unknown, outputNodeId?: string): unknown {
  const images = extractComfyImages(historyEntry, outputNodeId);
  return {
    prompt_id: promptId,
    status: images.length > 0 ? 'completed' : 'completed-no-images',
    images: buildComfyOutputFiles(runtime.baseUrl, images),
    history: historyEntry
  };
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
      let finalResponse: unknown;
      let bodyKind: 'json' | 'form-data';

      if (isComfyManifest(manifest, capability)) {
        const workflow = await loadComfyWorkflow(manifest);
        const comfyPayload = buildComfyExecutionPayload(manifest, request, workflow);
        const parsed = await this.executeWithRetry(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(comfyPayload)
        }, timeoutMs, retryConfig, manifest, context);
        const promptId = extractPromptId(parsed);
        if (!promptId) {
          throw new AppError(`Comfy pod ${manifest.id} did not return prompt_id from /prompt`, {
            code: 'COMFY_PROMPT_ID_MISSING',
            type: 'pod-request',
            statusCode: 502,
            retriable: false,
            details: { podId: manifest.id, response: parsed }
          });
        }

        finalResponse = await this.pollComfyHistory(runtime, timeoutMs, manifest, promptId, workflow.config.outputNodeId, context);
        bodyKind = 'json';
      } else {
        const built = await buildAdapterRequest(request);
        const init: RequestInit = {
          ...built,
          method
        };
        const parsed = await this.executeWithRetry(url, init, timeoutMs, retryConfig, manifest, context);
        finalResponse = runtime.resultPath
          ? await this.pollForResult(runtime, timeoutMs, manifest, context)
          : parsed;
        bodyKind = built.bodyKind;
      }

      return normalizeCompletedResult(manifest, request, capability, {
        acceptedAt: new Date().toISOString(),
        submitUrl: url,
        method,
        bodyKind,
        response: finalResponse
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw wrapJobExecutionError(manifest, error);
    }
  }

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

    if (lastError instanceof AppError) {
      throw lastError;
    }
    throw wrapJobExecutionError(manifest, lastError);
  }

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
          if (response.status === 404 || response.status === 202) {
            continue;
          }
          throw wrapPodRequestError(manifest, response.status, response.statusText, parsed);
        }

        if (isPollingComplete(parsed)) {
          return parsed;
        }
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
      }
    }

    throw new AppError(`Polling timed out for pod ${manifest.id} at ${resultUrl}`, {
      code: 'POLLING_TIMEOUT',
      type: 'job-execution',
      retriable: true,
      details: { podId: manifest.id, resultUrl, pollingTimeoutMs }
    });
  }

  private async pollComfyHistory(
    runtime: HttpServiceRuntime,
    requestTimeoutMs: number,
    manifest: PodManifest,
    promptId: string,
    outputNodeId?: string,
    context?: RunContext
  ): Promise<unknown> {
    const historyUrl = `${runtime.baseUrl}/history/${encodeURIComponent(promptId)}`;
    const intervalMs = runtime.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    const pollingTimeoutMs = runtime.pollingTimeoutMs ?? DEFAULT_POLLING_TIMEOUT_MS;
    const deadline = Date.now() + pollingTimeoutMs;

    while (Date.now() < deadline) {
      if (context?.signal?.aborted) {
        throw new AppError('Polling aborted', { code: 'POLLING_ABORTED', type: 'job-execution', retriable: false });
      }

      await sleep(intervalMs);

      try {
        const response = await fetchWithTimeout(historyUrl, { method: 'GET' }, requestTimeoutMs, context?.signal);
        const parsed = await parseResponseBody(response);

        if (!response.ok) {
          if (response.status === 404 || response.status === 202) {
            continue;
          }
          throw wrapPodRequestError(manifest, response.status, response.statusText, parsed);
        }

        if (isComfyHistoryPending(parsed, promptId)) {
          continue;
        }

        const historyEntry = isRecord(parsed) ? parsed[promptId] : undefined;
        return buildComfyResult(runtime, promptId, historyEntry, outputNodeId);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
      }
    }

    throw new AppError(`Comfy history polling timed out for pod ${manifest.id} and prompt ${promptId}`, {
      code: 'COMFY_HISTORY_TIMEOUT',
      type: 'job-execution',
      retriable: true,
      details: { podId: manifest.id, promptId, historyUrl, pollingTimeoutMs }
    });
  }
}

function isPollingComplete(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) {
    return true;
  }
  const record = parsed as Record<string, unknown>;
  if ('status' in record) {
    const status = String(record.status).toLowerCase();
    if (status === 'pending' || status === 'running' || status === 'queued' || status === 'processing') {
      return false;
    }
  }
  return true;
}
