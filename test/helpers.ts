import { builtinManifests } from '../src/manifests/builtin.js';
import type { PodManifest } from '../src/types.js';

export const testManifests = (): PodManifest[] =>
  builtinManifests.map((manifest) => ({
    ...manifest,
    runtime: {
      ...manifest.runtime,
      healthPath: undefined
    },
    startup: manifest.startup
      ? { ...manifest.startup, command: undefined, simulatedDelayMs: 0 }
      : undefined,
    shutdown: manifest.shutdown
      ? { ...manifest.shutdown, command: undefined, simulatedDelayMs: 0 }
      : undefined
  }));
