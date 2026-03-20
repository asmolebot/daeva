import type { PodManifest, PodPackageManifest } from './types.js';
import { podManifestSchema, podPackageManifestSchema } from './schemas.js';

export const parseManifest = (input: unknown): PodManifest => podManifestSchema.parse(input);

export const parsePodPackageManifest = (input: unknown): PodPackageManifest =>
  podPackageManifestSchema.parse(input);
