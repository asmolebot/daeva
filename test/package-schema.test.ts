import { describe, expect, it } from 'vitest';

import { parseManifest, parsePodPackageManifest } from '../src/manifest-loader.js';
import examplePodManifest from '../manifests/example.custom-pod.json' with { type: 'json' };
import examplePodPackage from '../examples/whisper-pod-package/pod-package.json' with { type: 'json' };

describe('pod manifest schema', () => {
  it('accepts the example standalone pod manifest', () => {
    const parsed = parseManifest(examplePodManifest);
    expect(parsed.id).toBe('vision-lora-worker');
    expect(parsed.manifestVersion).toBe('1');
  });

  it('rejects malformed package manifests', () => {
    expect(() =>
      parsePodPackageManifest({
        schemaVersion: '1',
        packageType: 'pod-package',
        name: 'broken',
        version: '0.0.1',
        pod: {
          id: 'broken'
        }
      })
    ).toThrow();
  });

  it('accepts the example portable pod package manifest', () => {
    const parsed = parsePodPackageManifest(examplePodPackage);
    expect(parsed.packageType).toBe('pod-package');
    expect(parsed.schemaVersion).toBe('1');
    expect(parsed.pod.manifestVersion).toBe('1');
    expect(parsed.examples?.[0]?.request.type).toBe('transcribe-audio');
  });
});
