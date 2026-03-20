export type PodCapability = 'image-generation' | 'speech-to-text' | 'ocr' | 'vision';
export type PodLifecycleStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type HttpMethod = 'GET' | 'POST';
export type PodManifestVersion = '1';
export type PodPackageSchemaVersion = '1';
export type PodRegistryIndexSchemaVersion = '1';
export type InstalledPackageStoreSchemaVersion = '1';

export interface PodManifest {
  id: string;
  nickname: string;
  description: string;
  manifestVersion?: PodManifestVersion;
  capabilities: PodCapability[];
  source: {
    homepage?: string;
    readme?: string;
    repository?: string;
  };
  runtime: {
    kind: 'http-service';
    baseUrl: string;
    healthPath?: string;
    submitPath: string;
    resultPath?: string;
    method?: HttpMethod;
  };
  startup?: {
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    simulatedDelayMs?: number;
  };
  shutdown?: {
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    simulatedDelayMs?: number;
  };
  exclusivityGroup?: string;
  metadata?: Record<string, unknown>;
}

export interface PodPackageManifest {
  schemaVersion: PodPackageSchemaVersion;
  packageType: 'pod-package';
  name: string;
  version: string;
  description?: string;
  pod: PodManifest;
  artifacts?: {
    readme?: string;
    icon?: string;
    dockerfile?: string;
    composeFile?: string;
    installScript?: string;
    startScript?: string;
    stopScript?: string;
    systemdUnit?: string;
    quadlet?: string;
  };
  directories?: Array<{
    path: string;
    purpose: 'config' | 'data' | 'models' | 'input' | 'output' | 'cache' | 'workspace' | 'custom';
    required?: boolean;
    createIfMissing?: boolean;
    description?: string;
  }>;
  environment?: Array<{
    name: string;
    required?: boolean;
    default?: string;
    description?: string;
    secret?: boolean;
  }>;
  install?: {
    strategy?: 'none' | 'dockerfile' | 'compose' | 'script' | 'prebuilt-image';
    notes?: string;
  };
  service?: {
    installMode?: 'manual' | 'user-systemd' | 'systemd' | 'quadlet';
    serviceName?: string;
  };
  examples?: Array<{
    name: string;
    description?: string;
    request: {
      type: string;
      capability?: PodCapability;
      input: Record<string, unknown>;
    };
  }>;
  source?: {
    homepage?: string;
    repository?: string;
    documentation?: string;
  };
}

export interface LocalFileRegistrySource {
  kind: 'local-file';
  path: string;
  packageManifestPath?: string;
}

export interface GithubRepoRegistrySource {
  kind: 'github-repo';
  repo: string;
  ref?: string;
  subpath?: string;
  packageManifestPath?: string;
}

export interface GitRepoRegistrySource {
  kind: 'git-repo';
  repoUrl: string;
  ref?: string;
  subpath?: string;
  packageManifestPath?: string;
}

export interface UploadedArchiveRegistrySource {
  kind: 'uploaded-archive';
  filename: string;
  archiveBase64: string;
  contentType?: string;
  subpath?: string;
  packageManifestPath?: string;
}

export interface RegistryIndexRegistrySource {
  kind: 'registry-index';
  indexUrl: string;
  alias: string;
}

export type RegistrySource =
  | LocalFileRegistrySource
  | GithubRepoRegistrySource
  | GitRepoRegistrySource
  | UploadedArchiveRegistrySource
  | RegistryIndexRegistrySource;

export interface PodRegistryIndexEntry {
  alias: string;
  packageName: string;
  podId?: string;
  description?: string;
  capabilities?: PodCapability[];
  tags?: string[];
  source: RegistrySource;
}

export interface PodRegistryIndex {
  schemaVersion: PodRegistryIndexSchemaVersion;
  indexType: 'pod-registry-index';
  name: string;
  description?: string;
  entries: PodRegistryIndexEntry[];
}

export interface InstalledPackageMetadata {
  alias: string;
  packageName: string;
  packageVersion: string;
  podId: string;
  installedAt: string;
  source: RegistrySource;
  sourcePath: string;
  packageManifestPath: string;
  materializedPath: string;
  manifest: PodPackageManifest;
}

export interface InstalledPackageMetadataCollection {
  schemaVersion: InstalledPackageStoreSchemaVersion;
  packages: InstalledPackageMetadata[];
}

export interface JobRequestFileBase {
  field?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface JobRequestFilePath extends JobRequestFileBase {
  source: 'path';
  path: string;
}

export interface JobRequestFileUpload extends JobRequestFileBase {
  source: 'upload';
  uploadBase64: string;
}

export type JobFileInput = JobRequestFilePath | JobRequestFileUpload;

export interface JobRequest {
  type: string;
  capability?: PodCapability;
  preferredPodId?: string;
  input: Record<string, unknown>;
  files?: JobFileInput[];
  metadata?: Record<string, unknown>;
}

export interface JobCapabilityContract {
  type: string;
  capability: PodCapability;
  inputKeys: string[];
  preferredPodId?: string;
  files: Array<{
    field: string;
    source: 'path' | 'upload';
    filename?: string;
    contentType?: string;
    path?: string;
    sizeBytes?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface JobResultOutputFile {
  url?: string;
  path?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface TranscriptSegment {
  startMs?: number;
  endMs?: number;
  text: string;
  confidence?: number;
  speaker?: string;
}

export interface DetectionBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DetectionItem {
  label: string;
  confidence?: number;
  text?: string;
  box?: DetectionBox;
  metadata?: Record<string, unknown>;
}

export interface GeneratedImageItem extends JobResultOutputFile {
  width?: number;
  height?: number;
}

export interface JobOutputError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retriable: boolean;
}

export interface JobOutputBase {
  files?: JobResultOutputFile[];
  raw?: unknown;
  error?: JobOutputError;
}

export interface SpeechToTextJobOutput extends JobOutputBase {
  kind: 'speech-to-text';
  transcript?: {
    text: string;
    language?: string;
    durationMs?: number;
    segments?: TranscriptSegment[];
  };
}

export interface OcrJobOutput extends JobOutputBase {
  kind: 'ocr';
  text?: string;
  detections?: DetectionItem[];
}

export interface VisionJobOutput extends JobOutputBase {
  kind: 'vision';
  text?: string;
  detections?: DetectionItem[];
}

export interface ImageGenerationJobOutput extends JobOutputBase {
  kind: 'image-generation';
  generatedImages?: GeneratedImageItem[];
}

export type JobOutput =
  | SpeechToTextJobOutput
  | OcrJobOutput
  | VisionJobOutput
  | ImageGenerationJobOutput;

export interface JobCompletedResult {
  status: 'succeeded' | 'failed';
  pod?: {
    id: string;
    nickname: string;
    runtime: {
      kind: 'http-service';
      baseUrl: string;
      submitPath: string;
      method: HttpMethod;
    };
  };
  request?: JobCapabilityContract;
  output: JobOutput;
}

export interface JobFailureInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retriable: boolean;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  request: JobRequest;
  selectedPodId?: string;
  resolvedCapability?: PodCapability;
  startedAt?: string;
  completedAt?: string;
  result?: JobCompletedResult;
  error?: JobFailureInfo;
}

export interface RunContext {
  signal?: AbortSignal;
}
