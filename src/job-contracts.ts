import { readFile } from 'node:fs/promises';

import { AppError, JobExecutionError, JobValidationError, PodRequestError, SchedulingError } from './errors.js';
import type {
  DetectionItem,
  GeneratedImageItem,
  JobCapabilityContract,
  JobCompletedResult,
  JobFileInput,
  JobOutput,
  JobRequest,
  JobRequestFileUpload,
  JobResultOutputFile,
  PodCapability,
  PodManifest,
  RunContext,
  TranscriptSegment
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

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

const unwrapPodResponse = (response: unknown): unknown => {
  if (!isRecord(response)) {
    return response;
  }

  return 'response' in response ? response.response : response;
};

const normalizeTranscriptSegments = (value: unknown): TranscriptSegment[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const segments = value.flatMap((segment) => {
    if (!isRecord(segment) || !hasNonEmptyString(segment.text)) {
      return [];
    }

    return [{
      text: segment.text,
      startMs: asNumber(segment.startMs ?? segment.start ?? segment.start_ms),
      endMs: asNumber(segment.endMs ?? segment.end ?? segment.end_ms),
      confidence: asNumber(segment.confidence),
      speaker: hasNonEmptyString(segment.speaker) ? segment.speaker : undefined
    } satisfies TranscriptSegment];
  });

  return segments.length > 0 ? segments : undefined;
};

const normalizeDetections = (value: unknown): DetectionItem[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const detections = value.flatMap((item) => {
    if (!isRecord(item) || !hasNonEmptyString(item.label ?? item.name ?? item.text)) {
      return [];
    }

    const boxSource = isRecord(item.box)
      ? item.box
      : isRecord(item.bbox)
        ? item.bbox
        : item;

    const metadata = isRecord(item.metadata) ? item.metadata : undefined;

    return [{
      label: String(item.label ?? item.name ?? item.text),
      confidence: asNumber(item.confidence ?? item.score),
      text: hasNonEmptyString(item.text) ? item.text : undefined,
      box: [boxSource.x, boxSource.y, boxSource.width ?? boxSource.w, boxSource.height ?? boxSource.h].some((part) => typeof part === 'number')
        ? {
            x: asNumber(boxSource.x),
            y: asNumber(boxSource.y),
            width: asNumber(boxSource.width ?? boxSource.w),
            height: asNumber(boxSource.height ?? boxSource.h)
          }
        : undefined,
      metadata
    } satisfies DetectionItem];
  });

  return detections.length > 0 ? detections : undefined;
};

const normalizeGeneratedImages = (response: unknown, files: JobResultOutputFile[]): GeneratedImageItem[] | undefined => {
  const source = isRecord(response) && Array.isArray(response.generatedImages)
    ? response.generatedImages
    : isRecord(response) && Array.isArray(response.images)
      ? response.images
      : files;

  if (!Array.isArray(source)) {
    return undefined;
  }

  const images = source.flatMap((item) => {
    if (isRecord(item)) {
      const url = hasNonEmptyString(item.url) ? item.url : undefined;
      const filePath = hasNonEmptyString(item.path) ? item.path : undefined;
      if (!url && !filePath) {
        return [];
      }

      return [{
        url,
        path: filePath,
        filename: hasNonEmptyString(item.filename) ? item.filename : undefined,
        contentType: hasNonEmptyString(item.contentType) ? item.contentType : undefined,
        sizeBytes: asNumber(item.sizeBytes),
        width: asNumber(item.width),
        height: asNumber(item.height),
        metadata: isRecord(item.metadata) ? item.metadata : undefined
      } satisfies GeneratedImageItem];
    }

    return [];
  });

  return images.length > 0 ? images : undefined;
};

const normalizeOutput = (capability: PodCapability, response: unknown): JobOutput => {
  const payload = unwrapPodResponse(response);
  const files = normalizeOutputFiles(payload);

  switch (capability) {
    case 'speech-to-text': {
      const transcriptText = isRecord(payload)
        ? (hasNonEmptyString(payload.transcript) ? payload.transcript : hasNonEmptyString(payload.text) ? payload.text : undefined)
        : hasNonEmptyString(payload)
          ? payload
          : undefined;
      const segments = isRecord(payload) ? normalizeTranscriptSegments(payload.segments) : undefined;
      return {
        kind: 'speech-to-text',
        transcript: transcriptText
          ? {
              text: transcriptText,
              language: isRecord(payload) && hasNonEmptyString(payload.language) ? payload.language : undefined,
              durationMs: isRecord(payload) ? asNumber(payload.durationMs ?? payload.duration_ms) : undefined,
              segments
            }
          : undefined,
        files,
        raw: response
      };
    }
    case 'ocr': {
      return {
        kind: 'ocr',
        text: isRecord(payload) && hasNonEmptyString(payload.text) ? payload.text : hasNonEmptyString(payload) ? payload : undefined,
        detections: isRecord(payload) ? normalizeDetections(payload.detections ?? payload.regions ?? payload.blocks) : undefined,
        files,
        raw: response
      };
    }
    case 'vision': {
      return {
        kind: 'vision',
        text: isRecord(payload) && hasNonEmptyString(payload.text) ? payload.text : hasNonEmptyString(payload) ? payload : undefined,
        detections: isRecord(payload) ? normalizeDetections(payload.detections ?? payload.objects ?? payload.labels) : undefined,
        files,
        raw: response
      };
    }
    case 'image-generation': {
      return {
        kind: 'image-generation',
        generatedImages: normalizeGeneratedImages(payload, files),
        files,
        raw: response
      };
    }
  }
};

export const normalizeCompletedResult = (manifest: PodManifest, request: JobRequest, capability: PodCapability, response: unknown): JobCompletedResult => ({
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
  output: normalizeOutput(capability, response)
});

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
    kind: capability ?? 'vision',
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
