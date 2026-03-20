import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFromAlias, planCreateFromAlias } from '../src/create-flow.js';
import { InstalledPackageStore } from '../src/installed-package-store.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-create-flow-'));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('create flow planning', () => {
  it('returns a coherent create plan for a local-file alias', () => {
    const registry = new PodRegistry();

    const plan = planCreateFromAlias(registry, { alias: 'whisper' });

    expect(plan?.resolvedSource.kind).toBe('local-file');
    expect(plan?.materialization.status).toBe('resolved');
    if (plan?.materialization.status !== 'resolved') {
      throw new Error('Expected unresolved planning materialization');
    }
    expect(plan.materialization.nextAction).toContain('Validate local package content');
  });

  it('materializes a local-file package and persists installed metadata', () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'installed-packages.json')
    });

    const result = createFromAlias(
      { alias: 'whisper' },
      {
        registry,
        podController,
        installedPackageStore,
        projectRoot: process.cwd(),
        managedPackagesRoot: path.join(tempRoot, 'materialized')
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') {
      throw new Error('Expected installed materialization');
    }

    expect(result.materialization.installedPackage.packageName).toBe('asmo-whisper');
    expect(installedPackageStore.list()).toHaveLength(1);
    expect(installedPackageStore.list()[0].manifest.pod.id).toBe('whisper');
  });

  it('returns undefined for an unknown alias when only planning', () => {
    const registry = new PodRegistry();
    expect(planCreateFromAlias(registry, { alias: 'missing' })).toBeUndefined();
  });
});
