import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('resolves a named github alias through POST /pods/create without materializing it yet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'comfy'
      }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();

    expect(body.create.alias).toBe('comfy');
    expect(body.create.registryEntry.packageName).toBe('asmo-comfy-community');
    expect(body.create.resolvedSource.kind).toBe('github-repo');
    expect(body.create.materialization.status).toBe('resolved');
    expect(body.create.materialization.nextAction).toContain('Clone asmoai/asmo-comfy-community-pod');
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
});
