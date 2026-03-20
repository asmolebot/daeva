import Fastify from 'fastify';

import { createFromAlias } from './create-flow.js';
import { NotFoundError } from './errors.js';
import { InstalledPackageStore } from './installed-package-store.js';
import { JobManager } from './job-manager.js';
import { PodController } from './pod-controller.js';
import { PodRegistry } from './registry.js';
import { SchedulerRouter } from './router.js';
import { registerManifestSchema, jobRequestSchema, podCreateRequestSchema } from './schemas.js';
import type { PodManifest } from './types.js';

export interface AppDependencies {
  registry?: PodRegistry;
  podController?: PodController;
  router?: SchedulerRouter;
  jobManager?: JobManager;
  installedPackageStore?: InstalledPackageStore;
  projectRoot?: string;
  managedPackagesRoot?: string;
}

export const buildApp = (dependencies: AppDependencies = {}) => {
  const registry = dependencies.registry ?? new PodRegistry();
  const podController = dependencies.podController ?? new PodController(registry.list());
  const router = dependencies.router ?? new SchedulerRouter(registry, podController);
  const jobManager = dependencies.jobManager ?? new JobManager(registry, podController, router);
  const installedPackageStore = dependencies.installedPackageStore ?? new InstalledPackageStore();

  const app = Fastify({ logger: false });

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
    const payload = podCreateRequestSchema.parse(request.body);

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
          error: error.message,
          knownAliases: registry.listAliases().map((entry) => entry.alias)
        };
      }

      throw error;
    }
  });

  app.get('/pods/aliases', async () => ({ aliases: registry.listAliases() }));
  app.get('/pods/installed', async () => ({ packages: installedPackageStore.list() }));

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
    if (error instanceof NotFoundError) {
      reply.code(404).send({ error: error.message });
      return;
    }

    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ZodError') {
      const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Invalid request';
      reply.code(400).send({ error: message });
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    reply.code(500).send({ error: message });
  });

  return { app, registry, podController, router, jobManager, installedPackageStore };
};
