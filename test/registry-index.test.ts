import { describe, expect, it } from 'vitest';

import {
  parsePodRegistryIndex,
  parseRegistrySource
} from '../src/manifest-loader.js';
import { PodRegistry } from '../src/registry.js';
import localRegistryIndex from '../src/manifests/local-registry-index.json' with { type: 'json' };

describe('registry source model', () => {
  it('accepts all supported registry source kinds', () => {
    expect(parseRegistrySource({ kind: 'local-file', path: 'examples/whisper-pod-package' }).kind).toBe('local-file');
    expect(parseRegistrySource({ kind: 'github-repo', repo: 'owner/repo', ref: 'main' }).kind).toBe('github-repo');
    expect(
      parseRegistrySource({
        kind: 'registry-index',
        indexUrl: 'https://registry.example.com/index.json',
        alias: 'vision'
      }).kind
    ).toBe('registry-index');
  });

  it('rejects malformed github repo sources', () => {
    expect(() => parseRegistrySource({ kind: 'github-repo', repo: 'not-a-repo' })).toThrow();
  });
});

describe('registry index + alias resolution', () => {
  it('accepts the sample local registry index', () => {
    const parsed = parsePodRegistryIndex(localRegistryIndex);
    expect(parsed.indexType).toBe('pod-registry-index');
    expect(parsed.entries).toHaveLength(4);
  });

  it('hydrates aliases into the registry and resolves named entries', () => {
    const registry = new PodRegistry();

    const whisper = registry.resolveAlias('whisper');
    const comfyapi = registry.resolveAlias('comfyapi');
    const comfy = registry.resolveAlias('comfy');
    const vision = registry.resolveAlias('vision');

    expect(registry.listRegistryIndexes()).toHaveLength(1);
    expect(registry.listAliases()).toHaveLength(4);

    expect(whisper?.source.kind).toBe('local-file');
    expect(comfyapi?.source.kind).toBe('local-file');
    expect(comfy?.source.kind).toBe('local-file');
    expect(comfy?.podId).toBe('comfyapi');
    expect(vision?.source.kind).toBe('registry-index');
    expect(vision?.source.kind === 'registry-index' ? vision.source.alias : undefined).toBe('ocr-vision');
  });
});
