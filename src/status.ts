import type { JobManager } from './job-manager.js';
import type { PodController } from './pod-controller.js';
import type { PodRegistry } from './registry.js';
import type { InstalledPackageStore } from './installed-package-store.js';
import { PodmanRuntimeInspector, inferDeclaredContainerName } from './runtime-inspector.js';
import type { RuntimeInspector } from './runtime-inspector.js';
import type { JobRecord, PodManifest, PodRegistryIndexEntry } from './types.js';

const defaultRuntimeInspector = new PodmanRuntimeInspector();

const buildHealthUrl = (manifest: PodManifest): string | undefined => {
  if (!manifest.runtime.healthPath) {
    return undefined;
  }

  return `${manifest.runtime.baseUrl}${manifest.runtime.healthPath}`;
};

const summarizeRegistrySources = (aliases: PodRegistryIndexEntry[]) => {
  const counts = aliases.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.source.kind] = (acc[entry.source.kind] ?? 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
};

export const buildRuntimeStatus = (
  registry: PodRegistry,
  podController: PodController,
  runtimeInspector: RuntimeInspector = defaultRuntimeInspector
) => {
  const manifests = registry.list();
  const inspection = runtimeInspector.inspect(manifests);
  const pods = podController.snapshot(manifests).map((entry) => {
    const declaredName = inferDeclaredContainerName(entry.manifest.startup?.command) ?? null;
    const container = declaredName ? inspection.containersByName.get(declaredName) : undefined;

    return {
      podId: entry.manifest.id,
      nickname: entry.manifest.nickname,
      status: entry.status,
      currentJobId: entry.currentJobId ?? null,
      lastStartedAt: entry.lastStartedAt ?? null,
      lastStoppedAt: entry.lastStoppedAt ?? null,
      exclusivityGroup: entry.manifest.exclusivityGroup ?? null,
      capabilities: entry.manifest.capabilities,
      runtime: {
        kind: entry.manifest.runtime.kind,
        baseUrl: entry.manifest.runtime.baseUrl,
        submitPath: entry.manifest.runtime.submitPath,
        healthPath: entry.manifest.runtime.healthPath ?? null,
        healthUrl: buildHealthUrl(entry.manifest) ?? null,
        method: entry.manifest.runtime.method ?? 'POST'
      },
      container: container
        ? {
            declaredName,
            name: container.name,
            names: container.names,
            image: container.image,
            state: container.state,
            status: container.status,
            ports: container.ports,
            inferredFrom: 'startup.command',
            detection: 'podman'
          }
        : {
            declaredName,
            name: declaredName,
            names: declaredName ? [declaredName] : [],
            image: null,
            state: null,
            status: null,
            ports: [],
            inferredFrom: entry.manifest.startup?.command ? 'startup.command' : null,
            detection: inspection.available ? 'podman-miss' : 'manifest-hint'
          }
    };
  });

  return {
    inspection: {
      backend: inspection.backend,
      available: inspection.available,
      error: inspection.error ?? null
    },
    summary: {
      totalPods: pods.length,
      runningPods: pods.filter((pod) => pod.status === 'running').length,
      busyPods: pods.filter((pod) => pod.currentJobId !== null).length,
      exclusivityGroups: [...new Set(pods.map((pod) => pod.exclusivityGroup).filter(Boolean))].length,
      observedContainers: pods.filter((pod) => pod.container.detection === 'podman').length
    },
    pods
  };
};

export const buildPackageStatus = (registry: PodRegistry, installedPackageStore: InstalledPackageStore) => {
  const aliases = registry.listAliases();
  const installedPackages = installedPackageStore.list();

  return {
    summary: {
      installedPackages: installedPackages.length,
      registryAliases: aliases.length,
      registryIndexes: registry.listRegistryIndexes().length,
      registrySourceKinds: summarizeRegistrySources(aliases)
    },
    installedPackages,
    registry: {
      aliases,
      indexes: registry.listRegistryIndexes().map((index) => ({
        name: index.name,
        description: index.description ?? null,
        entryCount: index.entries.length
      }))
    }
  };
};

export const buildSchedulerStatus = (registry: PodRegistry, podController: PodController, jobManager: JobManager) => {
  const manifests = registry.list();
  const runtimeStates = podController.snapshot(manifests);
  const groups = Array.from(
    runtimeStates.reduce<Map<string, typeof runtimeStates>>((acc, entry) => {
      const key = entry.manifest.exclusivityGroup ?? 'ungrouped';
      const existing = acc.get(key) ?? [];
      existing.push(entry);
      acc.set(key, existing);
      return acc;
    }, new Map())
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, entries]) => ({
      group,
      podIds: entries.map((entry) => entry.manifest.id),
      runningPodIds: entries.filter((entry) => entry.status === 'running').map((entry) => entry.manifest.id),
      busyPodIds: entries.filter((entry) => entry.currentJobId).map((entry) => entry.manifest.id),
      activeJobIds: entries.flatMap((entry) => (entry.currentJobId ? [entry.currentJobId] : []))
    }));

  return {
    summary: {
      queueDepth: jobManager.getQueueDepth(),
      processing: jobManager.isProcessing(),
      exclusivityGroups: groups.length
    },
    exclusivity: groups
  };
};

const toHistoryItem = (job: JobRecord) => ({
  id: job.id,
  type: job.request.type,
  capability: job.request.capability ?? null,
  status: job.status,
  selectedPodId: job.selectedPodId ?? null,
  createdAt: job.createdAt,
  startedAt: job.startedAt ?? null,
  completedAt: job.completedAt ?? null,
  updatedAt: job.updatedAt,
  error: job.error ?? null
});

export const buildRecentJobStatus = (jobManager: JobManager, limit = 10) => {
  const jobs = jobManager.listRecentJobs(limit);

  return {
    summary: {
      limit,
      totalTrackedJobs: jobManager.listJobs().length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      running: jobs.filter((job) => job.status === 'running').length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => job.status === 'failed').length
    },
    jobs: jobs.map(toHistoryItem)
  };
};

export const buildStatusSnapshot = (
  registry: PodRegistry,
  podController: PodController,
  jobManager: JobManager,
  installedPackageStore: InstalledPackageStore,
  runtimeInspector: RuntimeInspector = defaultRuntimeInspector
) => ({
  runtime: buildRuntimeStatus(registry, podController, runtimeInspector),
  packages: buildPackageStatus(registry, installedPackageStore),
  scheduler: buildSchedulerStatus(registry, podController, jobManager),
  jobs: buildRecentJobStatus(jobManager)
});
