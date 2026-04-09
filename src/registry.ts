import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import localRegistryIndex from './manifests/local-registry-index.json' with { type: 'json' };

import {
  parseManifest,
  parsePodRegistryIndex,
  parsePodRegistryIndexEntry
} from './manifest-loader.js';
import { builtinManifests } from './manifests/builtin.js';
import type {
  LocalFileRegistrySource,
  PodCapability,
  PodManifest,
  PodRegistryIndex,
  PodRegistryIndexEntry,
  RegistrySource
} from './types.js';

export interface PodRegistryOptions {
  registryIndexes?: PodRegistryIndex[];
  aliasEntries?: PodRegistryIndexEntry[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..');
const packagedExamplesRoot = path.join(packageRoot, 'examples');
const sourceExamplesRoot = path.resolve(moduleDir, '..', '..', 'examples');

const resolveBundledLocalPath = (inputPath: string): string => {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const normalized = inputPath.replace(/\\/g, '/');
  const exampleSuffix = normalized === 'examples' || normalized.startsWith('examples/')
    ? normalized.slice('examples'.length).replace(/^\//, '')
    : undefined;

  const candidates = [
    path.resolve(process.cwd(), inputPath),
    path.resolve(packageRoot, inputPath),
    path.resolve(moduleDir, inputPath),
    ...(exampleSuffix !== undefined
      ? [
          path.join(packagedExamplesRoot, exampleSuffix),
          path.join(sourceExamplesRoot, exampleSuffix)
        ]
      : [])
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? path.resolve(packageRoot, inputPath);
};

const normalizeRegistrySource = (source: RegistrySource): RegistrySource => {
  if (source.kind !== 'local-file') {
    return source;
  }

  return {
    ...source,
    path: resolveBundledLocalPath(source.path)
  };
};

const normalizeRegistryIndexEntry = (entry: PodRegistryIndexEntry): PodRegistryIndexEntry => ({
  ...entry,
  source: normalizeRegistrySource(entry.source)
});

const normalizeRegistryIndex = (index: PodRegistryIndex): PodRegistryIndex => ({
  ...index,
  entries: index.entries.map((entry) => normalizeRegistryIndexEntry(entry))
});

const isNormalizedLocalEntry = (entry: PodRegistryIndexEntry): boolean =>
  entry.source.kind === 'local-file' && path.isAbsolute(entry.source.path);

export class PodRegistry {
  private readonly manifests = new Map<string, PodManifest>();
  private readonly aliases = new Map<string, PodRegistryIndexEntry>();
  private readonly registryIndexes: PodRegistryIndex[] = [];

  constructor(initialManifests: PodManifest[] = builtinManifests, options: PodRegistryOptions = {}) {
    initialManifests.forEach((manifest) => this.register(manifest));

    const indexes = options.registryIndexes ?? [localRegistryIndex as PodRegistryIndex];
    indexes.forEach((index) => this.addRegistryIndex(index));

    options.aliasEntries?.forEach((entry) => this.registerAlias(entry));
  }

  register(manifest: PodManifest): PodManifest {
    const parsed = parseManifest(manifest);
    this.manifests.set(parsed.id, parsed);
    return parsed;
  }

  addRegistryIndex(index: PodRegistryIndex): PodRegistryIndex {
    const parsed = parsePodRegistryIndex(index);
    const normalized = normalizeRegistryIndex(parsed);
    this.registryIndexes.push(normalized);
    normalized.entries.forEach((entry) => {
      this.aliases.set(entry.alias, entry);
    });
    return normalized;
  }

  registerAlias(entry: PodRegistryIndexEntry): PodRegistryIndexEntry {
    const parsed = isNormalizedLocalEntry(entry) ? entry : parsePodRegistryIndexEntry(entry);
    const normalized = normalizeRegistryIndexEntry(parsed);
    this.aliases.set(normalized.alias, normalized);
    return normalized;
  }

  list(): PodManifest[] {
    return [...this.manifests.values()];
  }

  get(id: string): PodManifest | undefined {
    return this.manifests.get(id);
  }

  listAliases(): PodRegistryIndexEntry[] {
    return [...this.aliases.values()];
  }

  listRegistryIndexes(): PodRegistryIndex[] {
    return [...this.registryIndexes];
  }

  resolveAlias(alias: string): PodRegistryIndexEntry | undefined {
    return this.aliases.get(alias);
  }

  findByCapability(capability: PodCapability): PodManifest[] {
    return this.list().filter((manifest) => manifest.capabilities.includes(capability));
  }
}
