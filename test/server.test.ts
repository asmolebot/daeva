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
import { inferCapabilityForJobType } from '../src/job-contracts.js';
import type { RuntimeInspector } from '../src/runtime-inspector.js';
import type { JobRequest, PodManifest } from '../src/types.js';
import { testManifests } from './helpers.js';

class RecordingAdapter {
  async execute(manifest: PodManifest, request: JobRequest) {
    return {
      status: 'succeeded' as const,
      pod: {
        id: manifest.id,
        nickname: manifest.nickname,
        runtime: manifest.runtime
      },
      request: {
        type: request.type,
        capability: request.capability ?? inferCapabilityForJobType(request.type),
        inputKeys: Object.keys(request.input),
        preferredPodId: request.preferredPodId,
        files: (request.files ?? []).map((file) => ({
          field: file.field ?? 'file',
          source: file.source,
          filename: file.filename,
          contentType: file.contentType,
          path: file.source === 'path' ? file.path : undefined,
          sizeBytes: file.sizeBytes,
          metadata: file.metadata
        }))
      },
      output: {
        kind: request.capability ?? inferCapabilityForJobType(request.type),
        raw: {
          ok: true,
          podId: manifest.id,
          type: request.type,
          echoedInput: request.input
        }
      }
    };
  }
}

const fakeRuntimeInspector: RuntimeInspector = {
  inspect(manifests) {
    const containersByName = new Map([
      [
        'daeva-whisper',
        {
          name: 'daeva-whisper',
          names: ['daeva-whisper'],
          image: 'docker.io/library/daeva-whisper:latest',
          state: 'running',
          status: 'Up 5 minutes',
          ports: [
            {
              hostIp: '0.0.0.0',
              hostPort: 8001,
              containerPort: 8001,
              protocol: 'tcp'
            }
          ]
        }
      ]
    ]);

    const hasWhisper = manifests.some((manifest) => manifest.id === 'whisper');

    return {
      backend: 'podman',
      available: true,
      error: hasWhisper ? undefined : 'unexpected test fixture state',
      containersByName
    };
  }
};

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
const archiveBytes = readFileSync(tarGzPath);

/** Build a multipart/form-data payload buffer with the given parts. */
const buildMultipart = (
  parts: Array<{ name: string; value: string } | { name: string; filename: string; content: Buffer; contentType: string }>
) => {
  const boundary = '----AsmoTestBoundary' + Date.now();
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in part) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      chunks.push(part.content);
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(part.value));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
};

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
const { app } = await buildApp({
  registry,
  podController,
  router,
  jobManager,
  projectRoot: fixtureRoot,
  managedPackagesRoot,
  installedPackageStore,
  runtimeInspector: fakeRuntimeInspector,
  installHookOptions: {
    dryRun: true,
    skipPodmanSteps: true,
    templateContext: { HOME: path.join(installRoot, 'home') }
  }
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
    expect(body.aliases.map((entry: { alias: string }) => entry.alias)).toEqual(['whisper', 'comfyapi', 'comfy', 'vision']);
  });

  it('activates, swaps, and stops pods through explicit lifecycle endpoints', async () => {
    const activate = await app.inject({ method: 'POST', url: '/pods/whisper/activate' });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toEqual({ podId: 'whisper', status: 'running' });

    const swap = await app.inject({ method: 'POST', url: '/pods/swap', payload: { podId: 'comfyapi' } });
    expect(swap.statusCode).toBe(200);
    expect(swap.json()).toEqual({ podId: 'comfyapi', status: 'running' });

    const stop = await app.inject({ method: 'POST', url: '/pods/comfyapi/stop' });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ podId: 'comfyapi', status: 'stopped' });
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
    expect(body.create.materialization.installedPackage.packageName).toBe('daeva-whisper');
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
    expect(persisted.packages[0].packageName).toBe('daeva-whisper');
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

  it('returns an error when registry-index delegation cannot reach the remote index', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'vision'
      }
    });

    expect(response.statusCode).toBe(502);
    const body = response.json();

    expect(body.error.code).toBe('REGISTRY_INDEX_FETCH_ERROR');
    expect(body.error.message).toContain('registry.asmo.local');
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
    expect(body.error.message).toContain('Unknown pod alias: totally-not-real');
    expect(body.error.details.knownAliases).toEqual(['whisper', 'comfyapi', 'comfy', 'vision']);
  });

  it('rejects invalid jobs with a structured validation payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'generate-image',
        input: {}
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'JOB_VALIDATION_ERROR',
        type: 'validation',
        retriable: false
      }
    });
  });

  it('accepts a job and exposes its result', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'transcribe-audio',
        input: {},
        files: [
          {
            source: 'path',
            path: '/tmp/demo.wav',
            filename: 'demo.wav',
            contentType: 'audio/wav'
          }
        ]
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
    expect(resultResponse.json().result.status).toBe('succeeded');
    expect(resultResponse.json().result.pod.id).toBe('whisper');
    expect(resultResponse.json().result.request.capability).toBe('speech-to-text');
  });

  it('exposes a coherent status snapshot across runtime, packages, scheduler, and recent jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/status' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.runtime.inspection).toEqual({
      backend: 'podman',
      available: true,
      error: null
    });
    expect(body.runtime.summary.totalPods).toBe(3);
    expect(body.runtime.summary.observedContainers).toBe(1);
    expect(body.runtime.pods.find((pod: { podId: string }) => pod.podId === 'whisper').container).toEqual({
      declaredName: 'daeva-whisper',
      name: 'daeva-whisper',
      names: ['daeva-whisper'],
      image: 'docker.io/library/daeva-whisper:latest',
      state: 'running',
      status: 'Up 5 minutes',
      ports: [
        {
          hostIp: '0.0.0.0',
          hostPort: 8001,
          containerPort: 8001,
          protocol: 'tcp'
        }
      ],
      inferredFrom: 'startup.command',
      detection: 'podman'
    });
    expect(body.packages.summary.installedPackages).toBe(3);
    expect(body.packages.summary.registryAliases).toBe(4);
    expect(body.packages.summary.registrySourceKinds).toEqual([
      { kind: 'local-file', count: 3 },
      { kind: 'registry-index', count: 1 }
    ]);
    expect(body.scheduler.summary.exclusivityGroups).toBeGreaterThanOrEqual(1);
    expect(body.jobs.summary.totalTrackedJobs).toBeGreaterThanOrEqual(1);
  });

  it('exposes focused runtime, package, scheduler, and recent job status endpoints', async () => {
    const runtimeResponse = await app.inject({ method: 'GET', url: '/status/runtime' });
    expect(runtimeResponse.statusCode).toBe(200);
    const runtimeBody = runtimeResponse.json();
    expect(runtimeBody.inspection.available).toBe(true);
    expect(runtimeBody.summary.runningPods).toBeGreaterThanOrEqual(1);
    expect(runtimeBody.pods[0].runtime.baseUrl).toContain('http://127.0.0.1:');
    expect(runtimeBody.pods.find((pod: { podId: string }) => pod.podId === 'comfyapi').container.detection).toBe('podman-miss');

    const packagesResponse = await app.inject({ method: 'GET', url: '/status/packages' });
    expect(packagesResponse.statusCode).toBe(200);
    const packagesBody = packagesResponse.json();
    expect(packagesBody.installedPackages.map((pkg: { alias: string }) => pkg.alias)).toEqual(['archive-whisper', 'git-whisper', 'whisper']);
    expect(packagesBody.registry.indexes[0].entryCount).toBe(4);

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

  it('materializes a multipart archive upload through POST /pods/create', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'alias', value: 'multipart-whisper' },
      { name: 'subpath', value: 'archive-package' },
      { name: 'packageManifestPath', value: 'pod-package.json' },
      { name: 'archive', filename: 'whisper-package.tar.gz', content: archiveBytes, contentType: 'application/gzip' }
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      headers: { 'content-type': contentType },
      payload: body
    });

    if (response.statusCode !== 201) {
      console.error('MULTIPART DEBUG:', response.statusCode, response.body);
    }
    expect(response.statusCode).toBe(201);
    const responseBody = response.json();
    expect(responseBody.create.alias).toBe('multipart-whisper');
    expect(responseBody.create.resolvedSource.kind).toBe('uploaded-archive');
    expect(responseBody.create.materialization.status).toBe('installed');
    expect(responseBody.create.materialization.installedPackage.manifest.pod.id).toBe('whisper');
  });

  it('rejects oversized multipart archive uploads with 413', async () => {
    // Build a separate app with a tiny upload limit
    const tinyApp = (await buildApp({
      registry: new PodRegistry(testManifests()),
      podController: new PodController(registry.list()),
      installedPackageStore: new InstalledPackageStore(),
      projectRoot: fixtureRoot,
      managedPackagesRoot: path.join(installRoot, 'tiny-materialized'),
      uploadMaxBytes: 128 // 128 bytes — far smaller than any real archive
    })).app;

    try {
      const { body, contentType } = buildMultipart([
        { name: 'alias', value: 'oversized-test' },
        { name: 'archive', filename: 'big.tar.gz', content: archiveBytes, contentType: 'application/gzip' }
      ]);

      const response = await tinyApp.inject({
        method: 'POST',
        url: '/pods/create',
        headers: { 'content-type': contentType },
        payload: body
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('UPLOAD_TOO_LARGE');
    } finally {
      await tinyApp.close();
    }
  });

  it('cancels a queued job via POST /jobs/:jobId/cancel', async () => {
    // Build a separate app with a slow adapter so a job stays queued
    class SlowAdapter {
      async execute(manifest: PodManifest, request: JobRequest) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          status: 'succeeded' as const,
          pod: { id: manifest.id, nickname: manifest.nickname, runtime: manifest.runtime },
          request: {
            type: request.type,
            capability: request.capability ?? inferCapabilityForJobType(request.type),
            inputKeys: Object.keys(request.input),
            files: []
          },
          output: { kind: inferCapabilityForJobType(request.type), raw: {} }
        };
      }
    }

    const slowRegistry = new PodRegistry(testManifests());
    const slowController = new PodController(slowRegistry.list());
    const slowRouter = new SchedulerRouter(slowRegistry, slowController);
    const slowJobManager = new JobManager(slowRegistry, slowController, slowRouter, {
      adapter: new SlowAdapter()
    });
    const { app: slowApp } = await buildApp({
      registry: slowRegistry,
      podController: slowController,
      router: slowRouter,
      jobManager: slowJobManager,
      projectRoot: fixtureRoot,
      managedPackagesRoot: path.join(installRoot, 'cancel-test'),
      installedPackageStore: new InstalledPackageStore()
    });

    try {
      // Enqueue two jobs — first runs, second is queued
      await slowApp.inject({
        method: 'POST',
        url: '/jobs',
        payload: {
          type: 'generate-image',
          input: { prompt: 'blocker' }
        }
      });
      const secondResponse = await slowApp.inject({
        method: 'POST',
        url: '/jobs',
        payload: {
          type: 'generate-image',
          input: { prompt: 'cancel me' }
        }
      });

      const secondId = secondResponse.json().job.id;

      // Cancel the queued job
      const cancelResponse = await slowApp.inject({
        method: 'POST',
        url: `/jobs/${secondId}/cancel`
      });

      expect(cancelResponse.statusCode).toBe(200);
      expect(cancelResponse.json().cancelled).toBe(true);

      // Verify job status is cancelled
      const jobResponse = await slowApp.inject({
        method: 'GET',
        url: `/jobs/${secondId}`
      });
      expect(jobResponse.json().job.status).toBe('cancelled');

      await slowJobManager.waitForIdle();
    } finally {
      await slowApp.close();
    }
  });

  it('returns 409 when cancelling an already-completed job', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs',
      payload: {
        type: 'transcribe-audio',
        input: {},
        files: [{ source: 'path', path: '/tmp/cancel-test.wav', filename: 'cancel-test.wav', contentType: 'audio/wav' }]
      }
    });

    const jobId = createResponse.json().job.id;
    await jobManager.waitForIdle();

    const cancelResponse = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/cancel`
    });

    expect(cancelResponse.statusCode).toBe(409);
    expect(cancelResponse.json().error.code).toBe('CONFLICT');
  });

  it('returns 404 when cancelling a non-existent job', async () => {
    const cancelResponse = await app.inject({
      method: 'POST',
      url: '/jobs/job_nonexistent/cancel'
    });

    expect(cancelResponse.statusCode).toBe(404);
    expect(cancelResponse.json().error.code).toBe('NOT_FOUND');
  });

  it('still accepts JSON/base64 archive uploads as fallback on POST /pods/create', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pods/create',
      payload: {
        alias: 'json-fallback-whisper',
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
    const responseBody = response.json();
    expect(responseBody.create.alias).toBe('json-fallback-whisper');
    expect(responseBody.create.resolvedSource.kind).toBe('uploaded-archive');
    expect(responseBody.create.materialization.status).toBe('installed');
  });
});
