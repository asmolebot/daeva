export type PodCapability = 'image-generation' | 'speech-to-text' | 'ocr' | 'vision';
export type PodLifecycleStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type HttpMethod = 'GET' | 'POST';
export type PodManifestVersion = '1';
export type PodPackageSchemaVersion = '1';
export type PodRegistryIndexSchemaVersion = '1';
export type InstalledPackageStoreSchemaVersion = '1';

/** Runtime options forwarded to rpod exec calls. */
export interface RpodExecOptions {
  /** Timeout in seconds for rpod exec commands. */
  timeoutSecs?: number;
  /** Extra environment variables forwarded to the remote pod. */
  env?: Record<string, string>;
}

/** HTTP-service runtime — a local or remote HTTP endpoint. */
export interface HttpServiceRuntime {
  kind: 'http-service';
  baseUrl: string;
  healthPath?: string;
  submitPath: string;
  resultPath?: string;
  method?: HttpMethod;
}

/**
 * rpod runtime — executes jobs inside a remote GPU pod via the `rpod` CLI.
 * `rpod run` starts the pod, `rpod exec` forwards job payloads, `rpod stop`
 * tears it down, and `rpod ps` / `rpod discover` are used for health checks.
 */
export interface RpodRuntime {
  kind: 'rpod';
  /** The rpod CLI binary or full path (default: "rpod"). */
  command?: string;
  /** Remote host identifier passed to rpod (e.g. a hostname or pod-pool alias). */
  host: string;
  /**
   * GPU/device allocation spec forwarded to `rpod run --device`.
   * Examples: "gpu:0", "gpu:all", "cuda:0".
   */
  device?: string;
  /** Optional per-exec options. */
  execOptions?: RpodExecOptions;
}

export type PodRuntime = HttpServiceRuntime | RpodRuntime;

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
  runtime: PodRuntime;
  /**
   * install: One-time setup step run during package install (pull images,
   * create directories, write config). Does NOT start the pod.
   * Command strings may contain template variables (${HOME}, ${PACKAGE_DIR}, …).
   */
  install?: {
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    simulatedDelayMs?: number;
  };
  /**
   * build: Build a container image from source. Distinct from install so
   * orchestrators can re-build without repeating install steps.
   * Command strings may contain template variables.
   */
  build?: {
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    simulatedDelayMs?: number;
  };
  /**
   * startup: Bring the pod up and ready to accept jobs. Runs after install.
   * Command strings may contain template variables.
   */
  startup?: {
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    simulatedDelayMs?: number;
  };
  /**
   * shutdown: Stop the pod gracefully. Does not uninstall or remove images.
   * Command strings may contain template variables.
   */
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
    /**
     * How the pod service should be installed on the host.
     *   manual        - user manages start/stop themselves
     *   user-systemd  - user-scope systemd unit (systemctl --user)
     *   systemd       - system-scope systemd unit (requires root or sudo)
     *   quadlet       - Podman quadlet .container file (preferred for Podman)
     */
    installMode?: 'manual' | 'user-systemd' | 'systemd' | 'quadlet';
    /** Systemd/quadlet service unit name (without .service suffix). */
    serviceName?: string;
    /** Quadlet-specific metadata for generating/validating .container unit files. */
    quadlet?: {
      /** Container image reference. */
      image?: string;
      /** Port publish specs ("hostPort:containerPort[/proto]"). */
      publishPort?: string[];
      /**
       * Volume mount specs ("hostPath:containerPath[:options]").
       * Template variables are expanded before the quadlet file is written.
       */
      volume?: string[];
      /** Environment variables to inject ("KEY=VALUE"). */
      environment?: string[];
      /** Device access specs. */
      device?: string[];
      /** Network specs. */
      network?: string[];
      /** Container labels. */
      label?: Record<string, string>;
      /** Explicit container name override. */
      containerName?: string;
      /** Optional exec/command override. */
      exec?: string;
    };
    /** Systemd [Service]/[Install] metadata for user-systemd or systemd installMode. */
    systemd?: {
      after?: string[];
      wantedBy?: string[];
      restart?: 'no' | 'on-success' | 'on-failure' | 'on-abnormal' | 'on-abort' | 'always';
      timeoutStartSec?: number;
    };
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
    runtime: PodRuntime;
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
