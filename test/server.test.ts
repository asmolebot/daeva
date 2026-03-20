import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server.js';
import { InstalledPackageStore } from '../src/installed-package-store.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import type { JobRequest, PodManifest } from '../src/types.js';
import { testManifests } from './helpers.js';

class RecordingAdapter {
  async execute(manifest: PodManifest, request: JobRequest) {
    return {
      ok: true,
      podId: manifest.id,
      type: request.type,
      echoedInput: request.input
    };
  }
}

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-orch-fixtures-'));
cpSync(path.resolve(process.cwd(), 'examples'), path.join(fixtureRoot, 'examples'), { recursive: true });

const gitFixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-orch-git-fixture-'));
const gitRepoRoot = path.join(gitFixtureRoot, 'whisper-package.git');
execFileSync('git', ['init', gitRepoRoot], { stdio: 'pipe' });
cpSync(path.join(fixtureRoot, 'examples', 'whisper-pod-package'), path.join(gitRepoRoot, 'bundle'), { recursive: true });
execFileSync('git', ['-C', gitRepoRoot, 'add', '.'], { stdio: 'pipe' });
execFileSync('git', ['-C', gitRepoRoot, '-c', 'user.name=Asmo', '-c', 'user.email=asmo@example.com', 'commit', '-m', 'fixture'], { stdio: 'pipe' });



const archiveFixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-orch-archive-fixture-'));
const archivePackageRoot = path.join(archiveFixtureRoot, 'archive-package');
cpSync(path.join(fixtureRoot, 'examples', 'whisper-pod-package'), archivePackageRoot, { recursive: true });
const tarGzPath = path.join(archiveFixtureRoot, 'whisper-package.tar.gz');
execFileSync('tar', ['-czf', tarGzPath, '-C', archiveFixtureRoot, 'archive-package'], { stdio: 'pipe' });
const archiveBase64 = readFileSync(tarGzPath).toString('base64');

const installRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-orch-installed-'));
const storageFilePath = path.join(installRoot, 'installed-packages.json');
const managedPackagesRoot = path.join(installRoot, 'materialized');
const installedPackageStore = new InstalledPackageStore({ storageFilePath });

const registry = new PodRegistry(testManifests());
const podController = new PodController(registry.list());
const router = new SchedulerRouter(registry, podController);
const jobManager = new JobManager(registry, podController, router, {
  adapter: new RecordingAdapter()
});
const { app } = buildApp({
  registry,
  podController,
  router,
  jobManager,
  projectRoot: fixtureRoot,
  managedPackagesRoot,
  installedPackageStore
});

afterAll(async () => {
  await app.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(gitFixtureRoot, { recursive: true, force: true });
  rmSync(archiveFixtureRoot, { recursive: true, force: true });
  rmSync(installRoot, { recursive: true, force: true });
});

describe('HTTP API', () => {
  it('lists builtin pods', async () => {
    const response = await app.inject({ method: 'GET', url: '/pods' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pods).toHaveLength(3);
  });

  it('lists registry aliases', async () => {
    const response = await app.inject({ method: 'GET', url: '/pods/aliases' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.aliases.map((entry: { alias: string }) => entry.alias)).toEqual(['whisper', 'comfy', 'vision']);
  });

  it('materializes a local-file alias through POST /pods/create and exposes installed metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'whisper'
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.create.alias).toBe('whisper');
    expect(body.create.materialization.status).toBe('installed');
    expect(body.create.materialization.installedPackage.packageName).toBe('asmo-whisper');
    expect(body.create.materialization.installedPackage.materializedPath).toContain('materialized');
    expect(body.links.installed).toBe('/pods/installed');

    const installedResponse = await app.inject({ method: 'GET', url: '/pods/installed' });
    expect(installedResponse.statusCode).toBe(200);
    const installedBody = installedResponse.json();
    expect(installedBody.packages).toHaveLength(1);
    expect(installedBody.packages[0].alias).toBe('whisper');
    expect(installedBody.packages[0].manifest.pod.id).toBe('whisper');

    const persisted = JSON.parse(readFileSync(storageFilePath, 'utf8'));
    expect(persisted.packages).toHaveLength(1);
    expect(persisted.packages[0].packageName).toBe('asmo-whisper');
  });

  it('materializes a direct git-repo source through POST /pods/create and exposes installed metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'git-whisper',
        source: {
          kind: 'git-repo',
          repoUrl: `file://${gitRepoRoot}`,
          subpath: 'bundle',
          packageManifestPath: 'pod-package.json'
        }
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.create.alias).toBe('git-whisper');
    expect(body.create.resolvedSource.kind).toBe('git-repo');
    expect(body.create.materialization.status).toBe('installed');
    expect(body.create.materialization.installedPackage.source.kind).toBe('git-repo');
    expect(body.create.materialization.installedPackage.manifest.pod.id).toBe('whisper');

    const installedResponse = await app.inject({ method: 'GET', url: '/pods/installed' });
    expect(installedResponse.statusCode).toBe(200);
    const installedBody = installedResponse.json();
    expect(installedBody.packages.map((pkg: { alias: string }) => pkg.alias)).toEqual(['git-whisper', 'whisper']);
  });



  it('materializes an uploaded archive source through POST /pods/create and exposes installed metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'archive-whisper',
        source: {
          kind: 'uploaded-archive',
          filename: 'whisper-package.tar.gz',
          archiveBase64,
          subpath: 'archive-package',
          packageManifestPath: 'pod-package.json'
        }
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.create.alias).toBe('archive-whisper');
    expect(body.create.resolvedSource.kind).toBe('uploaded-archive');
    expect(body.create.materialization.status).toBe('installed');
    expect(body.create.materialization.installedPackage.source.kind).toBe('uploaded-archive');
    expect(body.create.materialization.installedPackage.manifest.pod.id).toBe('whisper');

    const installedResponse = await app.inject({ method: 'GET', url: '/pods/installed' });
    expect(installedResponse.statusCode).toBe(200);
    const installedBody = installedResponse.json();
    expect(installedBody.packages.map((pkg: { alias: string }) => pkg.alias)).toEqual(['archive-whisper', 'git-whisper', 'whisper']);
  });

  it('resolves a named registry-index alias through POST /pods/create without materializing it yet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'vision'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();

    expect(body.create.alias).toBe('vision');
    expect(body.create.resolvedSource.kind).toBe('registry-index');
    expect(body.create.materialization.status).toBe('resolved');
    expect(body.create.materialization.nextAction).toContain('Fetch registry index');
  });

  it('returns a useful 404 when POST /pods/create receives an unknown alias', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'totally-not-real'
      }
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toContain('Unknown pod alias: totally-not-real');
    expect(body.knownAliases).toEqual(['whisper', 'comfy', 'vision']);
  });

  it('accepts a job and exposes its result', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'transcribe-audio',
        input: { text: 'demo' }
      }
    });

    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json();
    await jobManager.waitForIdle();

    const jobResponse = await app.inject({ method: 'GET', url: `/jobs/${created.job.id}` });
    const resultResponse = await app.inject({ method: 'GET', url: `/jobs/${created.job.id}/result` });

    expect(jobResponse.statusCode).toBe(200);
    expect(jobResponse.json().job.status).toBe('completed');
    expect(resultResponse.statusCode).toBe(200);
    expect(resultResponse.json().result.podId).toBe('whisper');
  });

  it('exposes a coherent status snapshot across runtime, packages, scheduler, and recent jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.runtime.summary.totalPods).toBe(3);
    expect(body.runtime.pods.find((pod: { podId: string }) => pod.podId === 'whisper').container).toEqual({
      declaredName: null,
      inferredFrom: null,
      detection: 'manifest-hint'
    });
    expect(body.packages.summary.installedPackages).toBe(3);
    expect(body.packages.summary.registryAliases).toBe(3);
    expect(body.packages.summary.registrySourceKinds).toEqual([
      { kind: 'github-repo', count: 1 },
      { kind: 'local-file', count: 1 },
      { kind: 'registry-index', count: 1 }
    ]);
    expect(body.scheduler.summary.exclusivityGroups).toBeGreaterThanOrEqual(1);
    expect(body.jobs.summary.totalTrackedJobs).toBeGreaterThanOrEqual(1);
  });

  it('exposes focused runtime, package, scheduler, and recent job status endpoints', async () => {
    const runtimeResponse = await app.inject({ method: 'GET', url: '/status/runtime' });
    expect(runtimeResponse.statusCode).toBe(200);
    const runtimeBody = runtimeResponse.json();
    expect(runtimeBody.summary.runningPods).toBeGreaterThanOrEqual(1);
    expect(runtimeBody.pods[0].runtime.baseUrl).toContain('http://127.0.0.1:');

    const packagesResponse = await app.inject({ method: 'GET', url: '/status/packages' });
    expect(packagesResponse.statusCode).toBe(200);
    const packagesBody = packagesResponse.json();
    expect(packagesBody.installedPackages.map((pkg: { alias: string }) => pkg.alias)).toEqual(['archive-whisper', 'git-whisper', 'whisper']);
    expect(packagesBody.registry.indexes[0].entryCount).toBe(3);

    const schedulerResponse = await app.inject({ method: 'GET', url: '/status/scheduler' });
    expect(schedulerResponse.statusCode).toBe(200);
    const schedulerBody = schedulerResponse.json();
    expect(schedulerBody.summary.processing).toBe(false);
    expect(schedulerBody.exclusivity.find((group: { group: string }) => group.group === 'gpu-0').podIds).toEqual(['comfyapi', 'whisper', 'ocr-vision']);

    const jobsResponse = await app.inject({ method: 'GET', url: '/status/jobs/recent?limit=1' });
    expect(jobsResponse.statusCode).toBe(200);
    const jobsBody = jobsResponse.json();
    expect(jobsBody.summary.limit).toBe(1);
    expect(jobsBody.jobs).toHaveLength(1);
    expect(jobsBody.jobs[0].status).toBe('completed');
  });
});
