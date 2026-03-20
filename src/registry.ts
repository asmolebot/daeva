import localRegistryIndex from './manifests/local-registry-index.json' with { type: 'json' };

import {
  parseManifest,
  parsePodRegistryIndex,
  parsePodRegistryIndexEntry
} from './manifest-loader.js';
import { builtinManifests } from './manifests/builtin.js';
import type {
  PodCapability,
  PodManifest,
  PodRegistryIndex,
  PodRegistryIndexEntry
} from './types.js';

export interface PodRegistryOptions {
  registryIndexes?: PodRegistryIndex[];
  aliasEntries?: PodRegistryIndexEntry[];
}

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
    this.registryIndexes.push(parsed);
    parsed.entries.forEach((entry) => this.registerAlias(entry));
    return parsed;
  }

  registerAlias(entry: PodRegistryIndexEntry): PodRegistryIndexEntry {
    const parsed = parsePodRegistryIndexEntry(entry);
    this.aliases.set(parsed.alias, parsed);
    return parsed;
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
