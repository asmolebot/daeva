import { z } from 'zod';

const podCapabilitySchema = z.enum(['image-generation', 'speech-to-text', 'ocr', 'vision']);
const httpMethodSchema = z.enum(['GET', 'POST']);
const lifecycleCommandSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  simulatedDelayMs: z.number().int().nonnegative().optional()
});

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
  metadata: z.record(z.unknown()).optional()
});

export const registrySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local-file'),
    path: z.string().min(1),
    packageManifestPath: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('github-repo'),
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Expected owner/repo'),
    ref: z.string().min(1).optional(),
    subpath: z.string().min(1).optional(),
    packageManifestPath: z.string().min(1).optional()
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

export const jobRequestSchema = z.object({
  type: z.string().min(1),
  capability: podCapabilitySchema.optional(),
  preferredPodId: z.string().min(1).optional(),
  input: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional()
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
    readme: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
    composeFile: z.string().min(1).optional(),
    installScript: z.string().min(1).optional(),
    startScript: z.string().min(1).optional(),
    stopScript: z.string().min(1).optional(),
    systemdUnit: z.string().min(1).optional(),
    quadlet: z.string().min(1).optional()
  }).optional(),
  directories: z.array(z.object({
    path: z.string().min(1),
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
      input: z.record(z.unknown())
    })
  })).optional(),
  source: z.object({
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    documentation: z.string().url().optional()
  }).optional()
});
