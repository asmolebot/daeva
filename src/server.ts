import { createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import { authPlugin, type AuthPluginOptions } from './auth.js';
import { createFromAlias } from './create-flow.js';
import { AppError, NotFoundError } from './errors.js';
import { InstalledPackageStore } from './installed-package-store.js';
import { JobManager } from './job-manager.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import { SchedulerRouter } from './router.js';
import { registerManifestSchema, jobRequestSchema, podCreateRequestSchema } from './schemas.js';
import {
  buildPackageStatus,
  buildRecentJobStatus,
  buildRuntimeStatus,
  buildSchedulerStatus,
  buildStatusSnapshot
} from './status.js';
import type { RuntimeInspector } from './runtime-inspector.js';
import type { PodManifest, UploadedArchiveRegistrySource } from './types.js';

const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface AppDependencies {
  registry?: PodRegistry;
  podController?: PodController;
  router?: SchedulerRouter;
  jobManager?: JobManager;
  installedPackageStore?: InstalledPackageStore;
  projectRoot?: string;
  managedPackagesRoot?: string;
  runtimeInspector?: RuntimeInspector;
  auth?: AuthPluginOptions;
  rateLimit?: { max?: number; windowMs?: number };
  /** Maximum upload size in bytes for multipart archive uploads (default: 50 MiB). */
  uploadMaxBytes?: number;
}

export const buildApp = async (dependencies: AppDependencies = {}) => {
  const registry = dependencies.registry ?? new PodRegistry();
  const podController = dependencies.podController ?? new PodController(registry.list());
  const router = dependencies.router ?? new SchedulerRouter(registry, podController);
  const jobManager = dependencies.jobManager ?? new JobManager(registry, podController, router);
  const installedPackageStore = dependencies.installedPackageStore ?? new InstalledPackageStore();

  const uploadMaxBytes = dependencies.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const app = Fastify({ logger: false });

  // Multipart support (archive uploads on POST /pods/create)
  await app.register(multipart, {
    limits: { fileSize: uploadMaxBytes }
  });

  // Auth plugin (enabled when apiKeys provided)
  await app.register(authPlugin, dependencies.auth ?? {});

  // Rate limiting
  const rlMax = dependencies.rateLimit?.max ?? 100;
  const rlWindowMs = dependencies.rateLimit?.windowMs ?? 60_000;
  await app.register(rateLimit, {
    max: rlMax,
    timeWindow: rlWindowMs
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/pods', async () => ({ pods: jobManager.registrySnapshot() }));

  app.post('/pods/register', async (request, reply) => {
    const manifest = registerManifestSchema.parse(request.body) as PodManifest;
    registry.register(manifest);
    podController.syncManifest(manifest);
    reply.code(201);
    return { pod: manifest };
  });

  app.post('/pods/create', async (request, reply) => {
    let payload: ReturnType<typeof podCreateRequestSchema.parse>;

    const contentType = request.headers['content-type'] ?? '';
    if (contentType.includes('multipart/form-data')) {
      // Multipart upload: stream archive to disk, read metadata fields
      const fields: Record<string, string> = {};
      let archiveTempDir: string | undefined;
      let archiveTempPath: string | undefined;
      let archiveFilename: string | undefined;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'archive') {
            archiveFilename = part.filename;
            archiveTempDir = mkdtempSync(path.join(os.tmpdir(), 'asmo-multipart-'));
            archiveTempPath = path.join(archiveTempDir, path.basename(part.filename));
            await pipeline(part.file, createWriteStream(archiveTempPath));

            if (part.file.truncated) {
              rmSync(archiveTempDir, { recursive: true, force: true });
              reply.code(413);
              return {
                error: {
                  code: 'UPLOAD_TOO_LARGE',
                  type: 'validation',
                  message: `Upload exceeds ${Math.floor(uploadMaxBytes / (1024 * 1024))} MiB limit`,
                  retriable: false
                }
              };
            }
          } else if (part.type === 'field' && typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }

        if (!archiveTempPath || !archiveFilename) {
          if (archiveTempDir) rmSync(archiveTempDir, { recursive: true, force: true });
          reply.code(400);
          return {
            error: {
              code: 'REQUEST_VALIDATION_ERROR',
              type: 'validation',
              message: 'Multipart upload requires an "archive" file field',
              retriable: false
            }
          };
        }

        const source: UploadedArchiveRegistrySource = {
          kind: 'uploaded-archive',
          filename: archiveFilename,
          archiveBase64: 'multipart-upload',
          archivePath: archiveTempPath,
          subpath: fields.subpath,
          packageManifestPath: fields.packageManifestPath
        };

        payload = podCreateRequestSchema.parse({
          alias: fields.alias,
          source
        });
      } catch (error) {
        if (archiveTempDir) rmSync(archiveTempDir, { recursive: true, force: true });
        throw error;
      }

      // Run create flow, then clean up temp archive
      try {
        const plan = createFromAlias(payload, {
          registry,
          podController,
          installedPackageStore,
          projectRoot: dependencies.projectRoot,
          managedPackagesRoot: dependencies.managedPackagesRoot
        });

        reply.code(plan.materialization.status === 'installed' ? 201 : 202);
        return {
          create: plan,
          links: {
            aliases: '/pods/aliases',
            installed: '/pods/installed'
          }
        };
      } catch (error) {
        if (error instanceof NotFoundError) {
          reply.code(404);
          return {
            error: {
              code: error.code,
              type: error.type,
              message: error.message,
              retriable: error.retriable ?? false,
              details: {
                ...(error.details ?? {}),
                knownAliases: registry.listAliases().map((entry) => entry.alias)
              }
            }
          };
        }
        throw error;
      } finally {
        if (archiveTempDir) rmSync(archiveTempDir, { recursive: true, force: true });
      }
    }

    // JSON path (existing behavior)
    payload = podCreateRequestSchema.parse(request.body);

    try {
      const plan = createFromAlias(payload, {
        registry,
        podController,
        installedPackageStore,
        projectRoot: dependencies.projectRoot,
        managedPackagesRoot: dependencies.managedPackagesRoot
      });

      reply.code(plan.materialization.status === 'installed' ? 201 : 202);
      return {
        create: plan,
        links: {
          aliases: '/pods/aliases',
          installed: '/pods/installed'
        }
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        reply.code(404);
        return {
          error: {
            code: error.code,
            type: error.type,
            message: error.message,
            retriable: error.retriable ?? false,
            details: {
              ...(error.details ?? {}),
              knownAliases: registry.listAliases().map((entry) => entry.alias)
            }
          }
        };
      }

      throw error;
    }
  });

  app.get('/pods/aliases', async () => ({ aliases: registry.listAliases() }));
  app.get('/pods/installed', async () => ({ packages: installedPackageStore.list() }));

  app.get('/status', async () =>
    buildStatusSnapshot(registry, podController, jobManager, installedPackageStore, dependencies.runtimeInspector)
  );
  app.get('/status/runtime', async () => buildRuntimeStatus(registry, podController, dependencies.runtimeInspector));
  app.get('/status/packages', async () => buildPackageStatus(registry, installedPackageStore));
  app.get('/status/scheduler', async () => buildSchedulerStatus(registry, podController, jobManager));
  app.get('/status/jobs/recent', async (request) => {
    const query = request.query as { limit?: string | number };
    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : query.limit;
    const limit = Number.isFinite(rawLimit) && Number(rawLimit) > 0 ? Number(rawLimit) : 10;
    return buildRecentJobStatus(jobManager, limit);
  });

  app.get('/pods/packages/upload-spec', async () => ({
    status: 'scaffolded',
    accepts: ['tarball', 'docker-context', 'init-scripts'],
    plannedFields: ['manifest.json', 'Dockerfile', 'compose.yml', 'README.md'],
    note: 'Future feature: remote clients will upload pod packages for registration.'
  }));

  app.post('/jobs', async (request, reply) => {
    const payload = jobRequestSchema.parse(request.body);
    const job = jobManager.enqueue(payload);
    reply.code(202);
    return {
      job,
      links: {
        self: `/jobs/${job.id}`,
        result: `/jobs/${job.id}/result`
      }
    };
  });

  app.get('/jobs', async () => ({ jobs: jobManager.listJobs() }));

  app.get('/jobs/:jobId', async (request) => {
    const params = request.params as { jobId: string };
    return { job: jobManager.getJob(params.jobId) };
  });

  app.get('/jobs/:jobId/result', async (request) => {
    const params = request.params as { jobId: string };
    return { result: jobManager.getResult(params.jobId) };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(error.toResponseBody());
      return;
    }

    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ZodError') {
      const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Invalid request';
      reply.code(400).send({
        error: {
          code: 'REQUEST_VALIDATION_ERROR',
          type: 'validation',
          message,
          retriable: false,
          details: {
            issues: 'issues' in error ? error.issues : undefined
          }
        }
      });
      return;
    }

    // Rate limit errors from @fastify/rate-limit
    if (error.statusCode === 429) {
      reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          type: 'rate-limit',
          message: error.message,
          retriable: true
        }
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        type: 'internal',
        message,
        retriable: false
      }
    });
  });

  return { app, registry, podController, router, jobManager, installedPackageStore };
};
