import { builtinManifests } from '../src/manifests/builtin.js';
import { inferDeclaredContainerName } from '../src/runtime-inspector.js';
import type { PodManifest } from '../src/types.js';

export const testManifests = (): PodManifest[] =>
  builtinManifests.map((manifest) => {
    const declaredName = inferDeclaredContainerName(manifest.startup?.command);

    return ({
    ...manifest,
    runtime: {
      ...manifest.runtime,
      healthPath: undefined
    },
    startup: manifest.startup
      ? { ...manifest.startup, command: declaredName ? `echo --name ${declaredName} >/dev/null` : undefined, simulatedDelayMs: 0 }
      : undefined,
    shutdown: manifest.shutdown
      ? { ...manifest.shutdown, command: 'true', simulatedDelayMs: 0 }
      : undefined
  });
  });
