export type PodCapability = 'image-generation' | 'speech-to-text' | 'ocr' | 'vision';
export type PodLifecycleStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PodManifest {
  id: string;
  nickname: string;
  description: string;
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
    method?: 'GET' | 'POST';
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

export interface JobRequest {
  type: string;
  capability?: PodCapability;
  preferredPodId?: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  request: JobRequest;
  selectedPodId?: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export interface RunContext {
  signal?: AbortSignal;
}
