import { readFile } from 'node:fs/promises';

import { AppError, JobExecutionError, JobValidationError, PodRequestError, SchedulingError } from './errors.js';
import type {
  JobCapabilityContract,
  JobCompletedResult,
  JobFileInput,
  JobRequest,
  JobRequestFileUpload,
  JobResultOutputFile,
  PodCapability,
  PodManifest,
  RunContext
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const inferCapabilityForJobType = (type: string): PodCapability => {
  const lowered = type.toLowerCase();
  if (lowered.includes('transcrib') || lowered.includes('speech') || lowered.includes('audio')) {
    return 'speech-to-text';
  }
  if (lowered.includes('ocr') || lowered.includes('extract-text')) {
    return 'ocr';
  }
  if (lowered.includes('vision')) {
    return 'vision';
  }
  if (lowered.includes('image') || lowered.includes('render') || lowered.includes('generate')) {
    return 'image-generation';
  }

  throw new SchedulingError(`Unable to infer capability for job type: ${type}`, {
    details: { jobType: type }
  });
};

const summarizeJobFiles = (files: JobFileInput[] = []): JobCapabilityContract['files'] =>
  files.map((file) => ({
    field: file.field ?? 'file',
    source: file.source,
    filename: file.filename,
    contentType: file.contentType,
    path: file.source === 'path' ? file.path : undefined,
    sizeBytes: file.sizeBytes,
    metadata: file.metadata
  }));

const requiresAtLeastOne = (request: JobRequest, fields: string[], reason: string) => {
  const files = request.files ?? [];
  const hasSupportedField = fields.some((field) => request.input[field] !== undefined && request.input[field] !== null);
  if (!hasSupportedField && files.length === 0) {
    throw new JobValidationError(reason, {
      details: {
        capability: request.capability,
        acceptedFields: fields,
        receivedInputKeys: Object.keys(request.input),
        fileCount: files.length
      }
    });
  }
};

export const validateJobRequest = (request: JobRequest): PodCapability => {
  const capability = request.capability ?? inferCapabilityForJobType(request.type);
  const files = request.files ?? [];

  for (const file of files) {
    validateFileInput(file);
  }

  switch (capability) {
    case 'image-generation':
      if (!hasNonEmptyString(request.input.prompt)) {
        throw new JobValidationError('image-generation jobs require input.prompt', {
          details: {
            capability,
            expected: ['input.prompt'],
            receivedInputKeys: Object.keys(request.input)
          }
        });
      }
      break;
    case 'speech-to-text':
      requiresAtLeastOne(request, ['audioUrl', 'audioBase64', 'transcriptHint'], 'speech-to-text jobs require a file input or audioUrl/audioBase64-style input');
      break;
    case 'ocr':
      requiresAtLeastOne(request, ['imageUrl', 'documentUrl', 'imageBase64'], 'ocr jobs require a file input or image/document URL/base64 input');
      break;
    case 'vision':
      requiresAtLeastOne(request, ['imageUrl', 'imageBase64', 'prompt'], 'vision jobs require a file input or image input/prompt context');
      break;
  }

  return capability;
};

export const validateFileInput = (file: JobFileInput): void => {
  if (file.source === 'path') {
    if (!hasNonEmptyString(file.path)) {
      throw new JobValidationError('file inputs with source=path require path', {
        details: { file }
      });
    }
    return;
  }

  if (!hasNonEmptyString(file.uploadBase64)) {
    throw new JobValidationError('file inputs with source=upload require uploadBase64', {
      details: { file }
    });
  }
};

export const resolveUploadBuffer = (upload: JobRequestFileUpload): Buffer => Buffer.from(upload.uploadBase64, 'base64');

export const createCapabilityContract = (request: JobRequest, capability: PodCapability): JobCapabilityContract => ({
  type: request.type,
  capability,
  inputKeys: Object.keys(request.input),
  preferredPodId: request.preferredPodId,
  files: summarizeJobFiles(request.files)
});

const serializeErrorForResult = (error: unknown): JobCompletedResult['output']['error'] => {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retriable: error.retriable ?? false
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: error.message,
      retriable: false
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Unknown error',
    retriable: false
  };
};

const normalizeOutputFiles = (value: unknown): JobResultOutputFile[] => {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return [];
  }

  return value.files.flatMap((file) => {
    if (!isRecord(file) || !hasNonEmptyString(file.url || file.path)) {
      return [];
    }

    return [{
      url: hasNonEmptyString(file.url) ? file.url : undefined,
      path: hasNonEmptyString(file.path) ? file.path : undefined,
      filename: hasNonEmptyString(file.filename) ? file.filename : undefined,
      contentType: hasNonEmptyString(file.contentType) ? file.contentType : undefined,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : undefined,
      metadata: isRecord(file.metadata) ? file.metadata : undefined
    }];
  });
};

export const normalizeCompletedResult = (manifest: PodManifest, request: JobRequest, capability: PodCapability, response: unknown): JobCompletedResult => {
  const outputText = isRecord(response) && hasNonEmptyString(response.text) ? response.text : undefined;
  const outputFiles = normalizeOutputFiles(response);

  return {
    status: 'succeeded',
    pod: {
      id: manifest.id,
      nickname: manifest.nickname,
      runtime: {
        kind: manifest.runtime.kind,
        baseUrl: manifest.runtime.baseUrl,
        submitPath: manifest.runtime.submitPath,
        method: manifest.runtime.method ?? 'POST'
      }
    },
    request: createCapabilityContract(request, capability),
    output: {
      text: outputText,
      files: outputFiles,
      data: response
    }
  };
};

export const createFailedResult = (manifest: PodManifest | undefined, request: JobRequest, capability: PodCapability | undefined, error: unknown): JobCompletedResult => ({
  status: 'failed',
  pod: manifest
    ? {
        id: manifest.id,
        nickname: manifest.nickname,
        runtime: {
          kind: manifest.runtime.kind,
          baseUrl: manifest.runtime.baseUrl,
          submitPath: manifest.runtime.submitPath,
          method: manifest.runtime.method ?? 'POST'
        }
      }
    : undefined,
  request: capability ? createCapabilityContract(request, capability) : undefined,
  output: {
    error: serializeErrorForResult(error)
  }
});

export const buildAdapterRequest = async (request: JobRequest): Promise<RequestInit & { bodyKind: 'json' | 'form-data' }> => {
  const input = request.input ?? {};
  const files = request.files ?? [];

  if (files.length > 0) {
    const form = new FormData();

    for (const file of files) {
      const field = file.field ?? 'file';
      const filename = file.filename ?? (file.source === 'path' ? file.path.split('/').pop() : undefined) ?? 'upload.bin';
      const contentType = file.contentType ?? 'application/octet-stream';
      const bytes = file.source === 'path' ? await readFile(file.path) : resolveUploadBuffer(file);
      const blob = new Blob([bytes], { type: contentType });
      form.append(field, blob, filename);

      if (file.metadata) {
        form.append(`${field}__metadata`, JSON.stringify(file.metadata));
      }
    }

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    return {
      method: 'POST',
      body: form,
      bodyKind: 'form-data'
    };
  }

  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    bodyKind: 'json'
  };
};

export const wrapPodRequestError = (manifest: PodManifest, status: number, statusText: string, response: unknown): PodRequestError =>
  new PodRequestError(`Pod request failed (${status} ${statusText}) for ${manifest.id}`, {
    details: {
      podId: manifest.id,
      status,
      statusText,
      response
    },
    retriable: status >= 500
  });

export const wrapJobExecutionError = (manifest: PodManifest, error: unknown): JobExecutionError =>
  new JobExecutionError(`Job execution failed on pod ${manifest.id}`, {
    details: {
      podId: manifest.id,
      cause: error instanceof Error ? error.message : error
    },
    retriable: false,
    cause: error instanceof Error ? error : undefined
  });
