import { z } from 'zod';

const podCapabilitySchema = z.enum(['image-generation', 'speech-to-text', 'ocr', 'vision']);
const httpMethodSchema = z.enum(['GET', 'POST']);
const lifecycleCommandSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  simulatedDelayMs: z.number().int().nonnegative().optional()
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
  runtime: z.object({
    kind: z.literal('http-service'),
    baseUrl: z.string().url(),
    healthPath: z.string().optional(),
    submitPath: z.string().min(1),
    resultPath: z.string().optional(),
    method: httpMethodSchema.optional()
  }),
  startup: lifecycleCommandSchema.optional(),
  shutdown: lifecycleCommandSchema.optional(),
  exclusivityGroup: z.string().optional(),
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
    packageManifestPath: safeRelativePathSchema.optional()
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

export const jobRequestSchema = z.object({
  type: z.string().min(1),
  capability: podCapabilitySchema.optional(),
  preferredPodId: z.string().min(1).optional(),
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
    purpose: z.enum(['config', 'data', 'models', 'input', 'output', 'cache', 'workspace', 'custom']),
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
    installMode: z.enum(['manual', 'user-systemd', 'systemd', 'quadlet']).optional(),
    serviceName: z.string().min(1).optional()
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
  manifest: podPackageManifestSchema
});

export const installedPackageMetadataCollectionSchema = z.object({
  schemaVersion: z.literal('1'),
  packages: z.array(installedPackageMetadataSchema)
});
