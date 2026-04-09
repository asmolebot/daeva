import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createFromAlias } from '../src/create-flow.js';
import { runInstallHooks } from '../src/install-hooks.js';
import { parsePodPackageManifest } from '../src/manifest-loader.js';
import { InstalledPackageStore } from '../src/installed-package-store.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import comfyPodPackage from '../examples/pod-package-repos/daeva-comfyui-pod/pod-package.json' with { type: 'json' };

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'daeva-comfy-package-'));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('comfy package contract', () => {
  it('uses comfyapi as the canonical packaged identity', () => {
    const manifest = parsePodPackageManifest(comfyPodPackage);

    expect(manifest.name).toBe('daeva-comfyapi-pod');
    expect(manifest.pod.id).toBe('comfyapi');
    expect(manifest.pod.runtime.kind).toBe('http-service');
    if (manifest.pod.runtime.kind !== 'http-service') throw new Error('Expected http-service runtime');
    expect(manifest.pod.runtime.baseUrl).toBe('http://127.0.0.1:8188');
    expect(manifest.pod.runtime.healthPath).toBe('/system_stats');
    expect(JSON.stringify(manifest)).not.toContain('/home/clohl/');

    const metadata = manifest.pod.metadata as Record<string, any>;
    expect(metadata.workflow).toMatchObject({
      path: 'workflows/text-to-image.json',
      promptNodeId: '2',
      promptInputName: 'text',
      outputNodeId: '7'
    });
    expect(metadata.defaultModelArtifact.filename).toBe('comfyapi-demo-placeholder.safetensors');
    const readme = readFileSync(path.resolve(process.cwd(), 'examples/pod-package-repos/daeva-comfyui-pod/README.md'), 'utf8');
    expect(readme).toContain('/proxy/comfyapi');
  });

  it('runs install hooks, creates runtime dirs, and validates the deterministic default model artifact', async () => {
    const packageRoot = path.join(tempRoot, 'pkg-runtime');
    cpSync(path.resolve(process.cwd(), 'examples/pod-package-repos/daeva-comfyui-pod'), packageRoot, { recursive: true });

    const manifest = parsePodPackageManifest(JSON.parse(readFileSync(path.join(packageRoot, 'pod-package.json'), 'utf8')));
    const result = await runInstallHooks(manifest, packageRoot, { skipPodmanSteps: true });

    expect(result.ok).toBe(true);
    expect(result.resolvedDirectories.map((dir) => dir.purpose)).toEqual(['models', 'input', 'output', 'temp', 'custom-nodes']);
    expect(result.templateContext.MODELS_DIR).toContain('/data/models');
    expect(result.templateContext.CUSTOM_NODES_DIR).toContain('/data/custom_nodes');
    expect(result.templateContext.PACKAGE_DIR).toBe(packageRoot);
    expect(JSON.stringify(result)).not.toContain('/home/clohl/');

    const checkpointPath = path.join(packageRoot, 'data/models/checkpoints/comfyapi-demo-placeholder.safetensors');
    expect(existsSync(checkpointPath)).toBe(true);
    const sha = createHash('sha256').update(readFileSync(checkpointPath)).digest('hex');
    const metadata = manifest.pod.metadata as Record<string, any>;
    expect(sha).toBe(metadata.defaultModelArtifact.sha256);
    expect(existsSync(path.join(packageRoot, 'workflows/text-to-image.json'))).toBe(true);
  });

  it('materializes the canonical comfyapi alias, persists resolved install metadata, and overrides the builtin manifest', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'installed-comfyapi.json')
    });

    const result = await createFromAlias(
      { alias: 'comfyapi' },
      {
        registry,
        podController,
        installedPackageStore,
        projectRoot: path.join(tempRoot, 'pretend-installed-host'),
        managedPackagesRoot: path.join(tempRoot, 'materialized-comfyapi'),
        installHookOptions: { dryRun: true, skipPodmanSteps: true }
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') throw new Error('Expected installed package');

    const pkg = result.materialization.installedPackage;
    expect(pkg.alias).toBe('comfyapi');
    expect(pkg.podId).toBe('comfyapi');
    expect(pkg.sourcePath).toContain('daeva-comfyui-pod');
    expect(pkg.packageManifestPath).toContain('pod-package.json');
    expect(pkg.resolvedDirectories?.map((dir) => dir.purpose)).toContain('custom-nodes');
    expect(pkg.resolvedTemplateContext?.PACKAGE_DIR).toContain('materialized-comfyapi/comfyapi');
    const metadata = pkg.manifest.pod.metadata as Record<string, any>;
    expect(metadata.materializedPath).toContain('materialized-comfyapi/comfyapi');
    expect(metadata.resolvedTemplateContext?.PACKAGE_DIR).toContain('materialized-comfyapi/comfyapi');
    expect(JSON.stringify(pkg)).not.toContain('/home/clohl/');

    const activeManifest = registry.get('comfyapi');
    expect(activeManifest?.description).toBe('Image generation pod backed by ComfyUI.');
    expect(activeManifest?.startup?.command).toBe('${PACKAGE_DIR}/scripts/start.sh');
    expect(installedPackageStore.list()[0].manifest.pod.startup?.command).toBe('${PACKAGE_DIR}/scripts/start.sh');
  });
});
