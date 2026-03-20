import { parseManifest } from './manifest-loader.js';
import { builtinManifests } from './manifests/builtin.js';
import type { PodCapability, PodManifest } from './types.js';

export class PodRegistry {
  private readonly manifests = new Map<string, PodManifest>();

  constructor(initialManifests: PodManifest[] = builtinManifests) {
    initialManifests.forEach((manifest) => this.register(manifest));
  }

  register(manifest: PodManifest): PodManifest {
    const parsed = parseManifest(manifest);
    this.manifests.set(parsed.id, parsed);
    return parsed;
  }

  list(): PodManifest[] {
    return [...this.manifests.values()];
  }

  get(id: string): PodManifest | undefined {
    return this.manifests.get(id);
  }

  findByCapability(capability: PodCapability): PodManifest[] {
    return this.list().filter((manifest) => manifest.capabilities.includes(capability));
  }
}
