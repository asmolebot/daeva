import { z } from 'zod';

import type { PodManifest } from './types.js';

const manifestSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(z.enum(['image-generation', 'speech-to-text', 'ocr', 'vision'])).min(1),
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
    method: z.enum(['GET', 'POST']).optional()
  }),
  startup: z.object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    simulatedDelayMs: z.number().int().nonnegative().optional()
  }).optional(),
  shutdown: z.object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    simulatedDelayMs: z.number().int().nonnegative().optional()
  }).optional(),
  exclusivityGroup: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const parseManifest = (input: unknown): PodManifest => manifestSchema.parse(input);
