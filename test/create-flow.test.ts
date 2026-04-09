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

const archiveFixtureRoot = path.join(tempRoot, 'archive-fixture');
const archivePackageRoot = path.join(archiveFixtureRoot, 'archive-package');
mkdirSync(archiveFixtureRoot, { recursive: true });
cpSync(path.resolve(process.cwd(), 'examples/whisper-pod-package'), archivePackageRoot, { recursive: true });
const archivePath = path.join(archiveFixtureRoot, 'whisper-package.tar.gz');
execFileSync('tar', ['-czf', archivePath, '-C', archiveFixtureRoot, 'archive-package'], { stdio: 'pipe' });
const archiveBase64 = readFileSync(archivePath).toString('base64');

const traversalArchiveRoot = path.join(tempRoot, 'archive-traversal-fixture');
mkdirSync(traversalArchiveRoot, { recursive: true });
writeFileSync(path.join(traversalArchiveRoot, 'pod-package.json'), JSON.stringify({ nope: true }));
const traversalArchivePath = path.join(tempRoot, 'evil.tar');
execFileSync('tar', ['-cf', traversalArchivePath, '-C', traversalArchiveRoot, '--transform=s|pod-package.json|../escape/pod-package.json|', 'pod-package.json'], { stdio: 'pipe' });
const traversalArchiveBase64 = readFileSync(traversalArchivePath).toString('base64');

const installHookOptions = (homeSuffix: string) => ({
  dryRun: true,
  skipPodmanSteps: true,
  templateContext: { HOME: path.join(tempRoot, homeSuffix) }
});

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

  it('materializes a local-file package and persists installed metadata', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'installed-packages.json')
    });

    const result = await createFromAlias(
      { alias: 'whisper' },
      {
        registry,
        podController,
        installedPackageStore,
        projectRoot: process.cwd(),
        managedPackagesRoot: path.join(tempRoot, 'materialized'),
        installHookOptions: installHookOptions('home-local')
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') {
      throw new Error('Expected installed materialization');
    }

    expect(result.materialization.installedPackage.packageName).toBe('daeva-whisper');
    expect(result.materialization.installedPackage.resolvedDirectories?.[0]?.templateVars).toContain('MODELS_DIR');
    expect(result.materialization.installedPackage.resolvedTemplateContext?.MODELS_DIR).toContain('home-local');
    expect(installedPackageStore.list()).toHaveLength(1);
    expect(installedPackageStore.list()[0].manifest.pod.id).toBe('whisper');
  });

  it('materializes a direct git-repo source request into managed storage', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'git-installed-packages.json')
    });

    const result = await createFromAlias(
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
        managedPackagesRoot: path.join(tempRoot, 'git-materialized'),
        installHookOptions: installHookOptions('home-git')
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') {
      throw new Error('Expected installed materialization');
    }

    expect(result.materialization.installedPackage.alias).toBe('git-whisper');
    expect(result.materialization.installedPackage.source.kind).toBe('git-repo');
    expect(result.materialization.installedPackage.materializedPath).toContain('git-materialized');
    expect(readFileSync(result.materialization.installedPackage.packageManifestPath, 'utf8')).toContain('daeva-whisper');
    expect(installedPackageStore.list()).toHaveLength(1);
  });

  it('materializes a direct uploaded-archive source request into managed storage', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'archive-installed-packages.json')
    });

    const result = await createFromAlias(
      {
        alias: 'archive-whisper',
        source: {
          kind: 'uploaded-archive',
          filename: 'whisper-package.tar.gz',
          archiveBase64,
          subpath: 'archive-package',
          packageManifestPath: 'pod-package.json'
        }
      },
      {
        registry,
        podController,
        installedPackageStore,
        managedPackagesRoot: path.join(tempRoot, 'archive-materialized'),
        installHookOptions: installHookOptions('home-archive')
      }
    );

    expect(result.materialization.status).toBe('installed');
    if (result.materialization.status !== 'installed') {
      throw new Error('Expected installed materialization');
    }

    expect(result.materialization.installedPackage.alias).toBe('archive-whisper');
    expect(result.materialization.installedPackage.source.kind).toBe('uploaded-archive');
    expect(result.materialization.installedPackage.materializedPath).toContain('archive-materialized');
    expect(readFileSync(result.materialization.installedPackage.packageManifestPath, 'utf8')).toContain('daeva-whisper');
    expect(installedPackageStore.list()).toHaveLength(1);
  });

  it('rejects uploaded archive path traversal entries before extraction', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'bad-archive-installed-packages.json')
    });

    await expect(createFromAlias(
      {
        alias: 'bad-archive',
        source: {
          kind: 'uploaded-archive',
          filename: 'evil.tar',
          archiveBase64: traversalArchiveBase64
        }
      },
      {
        registry,
        podController,
        installedPackageStore,
        managedPackagesRoot: path.join(tempRoot, 'bad-archive-materialized'),
        installHookOptions: { dryRun: true, skipPodmanSteps: true }
      }
    )).rejects.toThrow(/path traversal/i);
  });

  it('rejects uploaded archive subpaths that attempt to escape the extracted root', async () => {
    const registry = new PodRegistry();
    const podController = new PodController(registry.list());
    const installedPackageStore = new InstalledPackageStore({
      storageFilePath: path.join(tempRoot, 'bad-subpath-installed-packages.json')
    });

    await expect(createFromAlias(
      {
        alias: 'bad-subpath',
        source: {
          kind: 'uploaded-archive',
          filename: 'whisper-package.tar.gz',
          archiveBase64,
          subpath: '../archive-package',
          packageManifestPath: 'pod-package.json'
        }
      },
      {
        registry,
        podController,
        installedPackageStore,
        managedPackagesRoot: path.join(tempRoot, 'bad-subpath-materialized'),
        installHookOptions: { dryRun: true, skipPodmanSteps: true }
      }
    )).rejects.toThrow(/package root/i);
  });

  it('returns undefined for an unknown alias when only planning', () => {
    const registry = new PodRegistry();
    expect(planCreateFromAlias(registry, { alias: 'missing' })).toBeUndefined();
  });
});
