import type {
  InstalledPackageMetadataCollection,
  PodManifest,
  PodPackageManifest,
  PodRegistryIndex,
  PodRegistryIndexEntry,
  RegistrySource
} from './types.js';
import {
  installedPackageMetadataCollectionSchema,
  podManifestSchema,
  podPackageManifestSchema,
  podRegistryIndexEntrySchema,
  podRegistryIndexSchema,
  registrySourceSchema
} from './schemas.js';

export const parseManifest = (input: unknown): PodManifest => podManifestSchema.parse(input);

export const parsePodPackageManifest = (input: unknown): PodPackageManifest =>
  podPackageManifestSchema.parse(input);

export const parseRegistrySource = (input: unknown): RegistrySource => registrySourceSchema.parse(input);

export const parsePodRegistryIndexEntry = (input: unknown): PodRegistryIndexEntry =>
  podRegistryIndexEntrySchema.parse(input);

export const parsePodRegistryIndex = (input: unknown): PodRegistryIndex =>
  podRegistryIndexSchema.parse(input);

export const parseInstalledPackageMetadataCollection = (input: unknown): InstalledPackageMetadataCollection =>
  installedPackageMetadataCollectionSchema.parse(input);
