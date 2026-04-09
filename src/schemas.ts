import { z } from 'zod';

const podCapabilitySchema = z.enum(['image-generation', 'speech-to-text', 'ocr', 'vision']);
const httpMethodSchema = z.enum(['GET', 'POST']);
const lifecycleCommandSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  simulatedDelayMs: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const retryConfigSchema = z.object({
  maxRetries: z.number().int().nonnegative().optional(),
  baseDelayMs: z.number().int().positive().optional(),
  maxDelayMs: z.number().int().positive().optional()
});

const healthCheckConfigSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().optional()
});

const safeRelativePathSchema = z.string().min(1).refine((value) => {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  const safe = normalized.split('/').filter(Boolean);
  return safe.length > 0 && !safe.includes('..');
}, 'Expected a package-relative path without path traversal');

const safeSourceFilenameSchema = z.string().min(1).max(255).refine((value) => value === value.split(/[\\/]/).pop(), 'filename must not include path separators');

const metadataRecordSchema = z.record(z.unknown());

const httpServiceRuntimeSchema = z.object({
  kind: z.literal('http-service'),
  baseUrl: z.string().url(),
  healthPath: z.string().optional(),
  submitPath: z.string().min(1),
  resultPath: z.string().optional(),
  method: httpMethodSchema.optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  retry: retryConfigSchema.optional(),
  pollingIntervalMs: z.number().int().positive().optional(),
  pollingTimeoutMs: z.number().int().positive().optional(),
  healthCheck: healthCheckConfigSchema.optional()
});

const rpodExecOptionsSchema = z.object({
  timeoutSecs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional()
});

const rpodRuntimeSchema = z.object({
  kind: z.literal('rpod'),
  /** rpod CLI binary name or full path (default: "rpod") */
  command: z.string().min(1).optional(),
  /** Remote host identifier passed to rpod */
  host: z.string().min(1),
  /** GPU/device allocation spec (e.g. "gpu:0", "cuda:0") */
  device: z.string().min(1).optional(),
  execOptions: rpodExecOptionsSchema.optional(),
  healthCheck: healthCheckConfigSchema.optional()
});

const podRuntimeSchema = z.discriminatedUnion('kind', [
  httpServiceRuntimeSchema,
  rpodRuntimeSchema
]);

export const podManifestSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().min(1),
  description: z.string().min(1),
  manifestVersion: z.literal('1').optional(),
  capabilities: z.array(podCapabilitySchema).min(1),
  source: z.object({
    homepage: z.string().url().optional(),
    readme: z.string().url().optional(),
    repository: z.string().url().optional()
  }),
  runtime: podRuntimeSchema,
  /**
   * install: Run once during package install. Intended for one-time setup
   * (pulling images, building, creating config files). Does NOT start the pod.
   * Template variables (${HOME}, ${PACKAGE_DIR}, etc.) are expanded at runtime.
   */
  install: lifecycleCommandSchema.optional(),
  /**
   * build: Build a container image from source (e.g. `podman build`). Distinct
   * from install so orchestrators can decide to re-build without reinstalling.
   * Template variables are expanded at runtime.
   */
  build: lifecycleCommandSchema.optional(),
  /**
   * startup: Bring the pod up and make it ready to accept jobs. Runs after install.
   * Template variables are expanded at runtime.
   */
  startup: lifecycleCommandSchema.optional(),
  /**
   * shutdown: Stop the pod gracefully. Does not uninstall or remove images.
   * Template variables are expanded at runtime.
   */
  shutdown: lifecycleCommandSchema.optional(),
  exclusivityGroup: z.string().optional(),
  costWeight: z.number().positive().optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  metadata: metadataRecordSchema.optional()
});

export const registrySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local-file'),
    path: z.string().min(1),
    packageManifestPath: safeRelativePathSchema.optional()
  }),
  z.object({
    kind: z.literal('github-repo'),
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Expected owner/repo'),
    ref: z.string().min(1).optional(),
    subpath: safeRelativePathSchema.optional(),
    packageManifestPath: safeRelativePathSchema.optional()
  }),
  z.object({
    kind: z.literal('git-repo'),
    repoUrl: z.string().url(),
    ref: z.string().min(1).optional(),
    subpath: safeRelativePathSchema.optional(),
    packageManifestPath: safeRelativePathSchema.optional()
  }),
  z.object({
    kind: z.literal('uploaded-archive'),
    filename: safeSourceFilenameSchema.refine((value) => /\.(zip|tar|tar\.gz|tgz)$/i.test(value), 'Supported archive types are .tar, .tar.gz, .tgz, and .zip'),
    archiveBase64: z.string().min(1),
    contentType: z.string().min(1).optional(),
    subpath: safeRelativePathSchema.optional(),
    packageManifestPath: safeRelativePathSchema.optional(),
    /** Internal: path to a pre-written archive file (set by multipart upload handler). */
    archivePath: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('registry-index'),
    indexUrl: z.string().url(),
    alias: z.string().min(1)
  })
]);

export const podRegistryIndexEntrySchema = z.object({
  alias: z.string().min(1),
  packageName: z.string().min(1),
  podId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  capabilities: z.array(podCapabilitySchema).min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  source: registrySourceSchema
});

export const podRegistryIndexSchema = z.object({
  schemaVersion: z.literal('1'),
  indexType: z.literal('pod-registry-index'),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  entries: z.array(podRegistryIndexEntrySchema).min(1)
});

const jobFileCommonSchema = {
  field: z.string().min(1).max(128).optional(),
  filename: safeSourceFilenameSchema.optional(),
  contentType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
  metadata: metadataRecordSchema.optional()
};

const jobFileInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('path'),
    path: z.string().min(1),
    ...jobFileCommonSchema
  }),
  z.object({
    source: z.literal('upload'),
    uploadBase64: z.string().min(1),
    ...jobFileCommonSchema
  })
]);

const jobPrioritySchema = z.enum(['low', 'normal', 'high', 'critical']);

export const jobRequestSchema = z.object({
  type: z.string().min(1),
  capability: podCapabilitySchema.optional(),
  preferredPodId: z.string().min(1).optional(),
  priority: jobPrioritySchema.optional(),
  input: metadataRecordSchema,
  files: z.array(jobFileInputSchema).max(16).optional(),
  metadata: metadataRecordSchema.optional()
});

export const podCreateRequestSchema = z.object({
  alias: z.string().min(1).optional(),
  source: registrySourceSchema.refine((source) => source.kind !== 'registry-index', {
    message: 'Direct create only supports local-file, github-repo, git-repo, or uploaded-archive sources'
  }).optional()
}).superRefine((value, ctx) => {
  if (!value.alias && !value.source) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected alias or source'
    });
  }
});

export const registerManifestSchema = podManifestSchema;

export const podPackageManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  packageType: z.literal('pod-package'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  pod: podManifestSchema,
  artifacts: z.object({
    readme: safeRelativePathSchema.optional(),
    icon: safeRelativePathSchema.optional(),
    dockerfile: safeRelativePathSchema.optional(),
    composeFile: safeRelativePathSchema.optional(),
    installScript: safeRelativePathSchema.optional(),
    startScript: safeRelativePathSchema.optional(),
    stopScript: safeRelativePathSchema.optional(),
    systemdUnit: safeRelativePathSchema.optional(),
    quadlet: safeRelativePathSchema.optional()
  }).optional(),
  directories: z.array(z.object({
    path: safeRelativePathSchema,
    purpose: z.enum(['config', 'data', 'models', 'input', 'output', 'cache', 'workspace', 'custom', 'temp', 'custom-nodes']),
    required: z.boolean().optional(),
    createIfMissing: z.boolean().optional(),
    description: z.string().min(1).optional()
  })).optional(),
  environment: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean().optional(),
    default: z.string().optional(),
    description: z.string().min(1).optional(),
    secret: z.boolean().optional()
  })).optional(),
  install: z.object({
    strategy: z.enum(['none', 'dockerfile', 'compose', 'script', 'prebuilt-image']).optional(),
    notes: z.string().min(1).optional()
  }).optional(),
  service: z.object({
    /**
     * How the pod service should be installed on the host.
     *   manual        - user manages start/stop themselves
     *   user-systemd  - user-scope systemd unit (systemctl --user)
     *   systemd       - system-scope systemd unit (requires root or sudo)
     *   quadlet       - Podman quadlet .container file (preferred for Podman)
     */
    installMode: z.enum(['manual', 'user-systemd', 'systemd', 'quadlet']).optional(),
    /** Systemd/quadlet service unit name (without .service suffix). */
    serviceName: z.string().min(1).optional(),
    /**
     * Quadlet-specific metadata.  When installMode is "quadlet" these fields
     * can be used to generate or validate a .container quadlet unit file.
     * All path/volume values support template variables (${HOME}, ${PACKAGE_DIR}, …).
     */
    quadlet: z.object({
      /** Container image reference (e.g. "docker.io/library/daeva-whisper:latest"). */
      image: z.string().min(1).optional(),
      /** Port publish specs, each in the form "hostPort:containerPort[/proto]". */
      publishPort: z.array(z.string().min(1)).optional(),
      /**
       * Volume mount specs, each in the form "hostPath:containerPath[:options]".
       * Template variables are expanded before the quadlet file is written.
       */
      volume: z.array(z.string().min(1)).optional(),
      /** Environment variables to inject, each in the form "KEY=VALUE". */
      environment: z.array(z.string().min(1)).optional(),
      /** Device access specs, each in the form "hostDevice[:containerDevice]". */
      device: z.array(z.string().min(1)).optional(),
      /** Network specs (e.g. ["host"] or ["bridge"]). */
      network: z.array(z.string().min(1)).optional(),
      /** Container labels as key/value pairs. */
      label: z.record(z.string()).optional(),
      /** Explicit container name (overrides the quadlet-derived default). */
      containerName: z.string().min(1).optional(),
      /** Optional entrypoint/command override passed to the container. */
      exec: z.string().min(1).optional()
    }).optional(),
    /**
     * Systemd [Service] and [Install] section metadata.
     * Used when installMode is "user-systemd" or "systemd".
     */
    systemd: z.object({
      /** Units to start before this service (After= directive). */
      after: z.array(z.string().min(1)).optional(),
      /** Targets that should pull in this unit (WantedBy= directive). */
      wantedBy: z.array(z.string().min(1)).optional(),
      /** Restart policy (maps to Restart= directive). */
      restart: z.enum(['no', 'on-success', 'on-failure', 'on-abnormal', 'on-abort', 'always']).optional(),
      /** Maximum seconds to wait for the service to start (TimeoutStartSec=). */
      timeoutStartSec: z.number().int().positive().optional()
    }).optional()
  }).optional(),
  examples: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    request: z.object({
      type: z.string().min(1),
      capability: podCapabilitySchema.optional(),
      input: metadataRecordSchema
    })
  })).optional(),
  source: z.object({
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    documentation: z.string().url().optional()
  }).optional()
});

export const installedPackageMetadataSchema = z.object({
  alias: z.string().min(1),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  podId: z.string().min(1),
  installedAt: z.string().datetime(),
  source: registrySourceSchema,
  sourcePath: z.string().min(1),
  packageManifestPath: z.string().min(1),
  materializedPath: z.string().min(1),
  manifest: podPackageManifestSchema,
  resolvedTemplateContext: z.record(z.string()).optional(),
  resolvedDirectories: z.array(z.object({
    path: z.string().min(1),
    purpose: z.enum(['config', 'data', 'models', 'input', 'output', 'cache', 'workspace', 'custom', 'temp', 'custom-nodes']),
    description: z.string().min(1).optional(),
    templateVars: z.array(z.string().min(1))
  })).optional()
});

export const installedPackageMetadataCollectionSchema = z.object({
  schemaVersion: z.literal('1'),
  packages: z.array(installedPackageMetadataSchema)
});
