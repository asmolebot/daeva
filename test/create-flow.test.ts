import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFromAlias, planCreateFromAlias } from '../src/create-flow.js';
import { InstalledPackageStore } from '../src/installed-package-store.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-create-flow-'));
const gitRepoRoot = path.join(tempRoot, 'repos', 'git-whisper-package');
const gitPackageWorktree = path.join(tempRoot, 'git-package-worktree');

cpSync(path.resolve(process.cwd(), 'examples/whisper-pod-package'), gitPackageWorktree, { recursive: true });
mkdirSync(path.dirname(gitRepoRoot), { recursive: true });
execFileSync('git', ['init', gitRepoRoot], { stdio: 'pipe' });
writeFileSync(path.join(gitRepoRoot, '.gitignore'), '\n');
cpSync(gitPackageWorktree, path.join(gitRepoRoot, 'package'), { recursive: true });
execFileSync('git', ['-C', gitRepoRoot, 'add', '.'], { stdio: 'pipe' });
execFileSync('git', ['-C', gitRepoRoot, '-c', 'user.name=Asmo', '-c', 'user.email=asmo@example.com', 'commit', '-m', 'fixture'], { stdio: 'pipe' });

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

  it('materializes a direct git-repo source request into managed storage', () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'git-installed-packages.json')
    });

    const result = createFromAlias(
      {
        alias: 'git-whisper',
        source: {
          kind: 'git-repo',
          repoUrl: `file://${gitRepoRoot}`,
          subpath: 'package',
          packageManifestPath: 'pod-package.json'
        }
      },
      {
        registry,
        podController,
        installedPackageStore,
        managedPackagesRoot: path.join(tempRoot, 'git-materialized')
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') {
      throw new Error('Expected installed materialization');
    }

    expect(result.materialization.installedPackage.alias).toBe('git-whisper');
    expect(result.materialization.installedPackage.source.kind).toBe('git-repo');
    expect(result.materialization.installedPackage.materializedPath).toContain('git-materialized');
    expect(readFileSync(result.materialization.installedPackage.packageManifestPath, 'utf8')).toContain('asmo-whisper');
    expect(installedPackageStore.list()).toHaveLength(1);
  });

  it('returns undefined for an unknown alias when only planning', () => {
    const registry = new PodRegistry();
    expect(planCreateFromAlias(registry, { alias: 'missing' })).toBeUndefined();
  });
});
