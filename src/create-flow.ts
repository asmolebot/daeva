import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NotFoundError } from './errors.js';
import { parsePodPackageManifest } from './manifest-loader.js';
import type { InstalledPackageStore } from './installed-package-store.js';
import type { PodController } from './pod-controller.js';
import type { PodRegistry } from './registry.js';
import type {
  GithubRepoRegistrySource,
  InstalledPackageMetadata,
  LocalFileRegistrySource,
  PodRegistryIndexEntry,
  RegistryIndexRegistrySource,
  RegistrySource
} from './types.js';

export interface PodCreateRequest {
  alias: string;
}

export interface MaterializedPodCreatePlan {
  status: 'installed';
  summary: string;
  installedPackage: InstalledPackageMetadata;
}

export interface UnresolvedPodCreatePlan {
  status: 'resolved';
  summary: string;
  nextAction: string;
}

export interface PodCreatePlan {
  request: PodCreateRequest;
  alias: string;
  registryEntry: PodRegistryIndexEntry;
  resolvedSource: RegistrySource;
  materialization: MaterializedPodCreatePlan | UnresolvedPodCreatePlan;
}

export interface CreateFromAliasOptions {
  registry: PodRegistry;
  podController: PodController;
  installedPackageStore: InstalledPackageStore;
  projectRoot?: string;
  managedPackagesRoot?: string;
}

const describeSource = (source: RegistrySource): string => {
  switch (source.kind) {
    case 'local-file':
      return describeLocalFileSource(source);
    case 'github-repo':
      return describeGithubRepoSource(source);
    case 'registry-index':
      return describeRegistryIndexSource(source);
  }
};

const describeLocalFileSource = (source: LocalFileRegistrySource): string => {
  const manifestNote = source.packageManifestPath
    ? ` using manifest ${source.packageManifestPath}`
    : '';
  return `Validate local package content at ${source.path}${manifestNote}, then materialize it into managed storage.`;
};

const describeGithubRepoSource = (source: GithubRepoRegistrySource): string => {
  const refNote = source.ref ? ` at ref ${source.ref}` : '';
  const manifestNote = source.packageManifestPath
    ? ` and read ${source.packageManifestPath}`
    : '';
  return `Clone ${source.repo}${refNote}${manifestNote}, validate the package manifest, then materialize it into managed storage.`;
};

const describeRegistryIndexSource = (source: RegistryIndexRegistrySource): string =>
  `Fetch registry index ${source.indexUrl}, resolve alias ${source.alias}, then continue materialization from the delegated source.`;

const resolveLocalSourcePaths = (projectRoot: string, source: LocalFileRegistrySource) => {
  const sourcePath = path.resolve(projectRoot, source.path);
  const packageManifestPath = path.resolve(
    projectRoot,
    source.packageManifestPath ?? path.join(source.path, 'pod-package.json')
  );

  return { sourcePath, packageManifestPath };
};

const materializeLocalFilePackage = (
  registryEntry: PodRegistryIndexEntry,
  source: LocalFileRegistrySource,
  options: CreateFromAliasOptions
): MaterializedPodCreatePlan => {
  const projectRoot = options.projectRoot ?? process.cwd();
  const managedPackagesRoot = options.managedPackagesRoot ?? path.resolve(projectRoot, '.data/pod-packages');
  const { sourcePath, packageManifestPath } = resolveLocalSourcePaths(projectRoot, source);
  const manifest = parsePodPackageManifest(JSON.parse(readFileSync(packageManifestPath, 'utf8')));

  const managedAliasPath = path.join(managedPackagesRoot, registryEntry.alias);
  mkdirSync(managedPackagesRoot, { recursive: true });
  cpSync(sourcePath, managedAliasPath, { recursive: true, force: true });

  const installedPackage: InstalledPackageMetadata = {
    alias: registryEntry.alias,
    packageName: manifest.name,
    packageVersion: manifest.version,
    podId: manifest.pod.id,
    installedAt: new Date().toISOString(),
    source,
    sourcePath,
    packageManifestPath,
    materializedPath: managedAliasPath,
    manifest
  };

  if (!options.registry.get(manifest.pod.id)) {
    options.registry.register(manifest.pod);
    options.podController.syncManifest(manifest.pod);
  }
  options.installedPackageStore.upsert(installedPackage);

  return {
    status: 'installed',
    summary: `Installed local package ${manifest.name}@${manifest.version} for alias ${registryEntry.alias}.`,
    installedPackage
  };
};

export const createFromAlias = (request: PodCreateRequest, options: CreateFromAliasOptions): PodCreatePlan => {
  const registryEntry = options.registry.resolveAlias(request.alias);

  if (!registryEntry) {
    throw new NotFoundError(`Unknown pod alias: ${request.alias}`);
  }

  const materialization = registryEntry.source.kind === 'local-file'
    ? materializeLocalFilePackage(registryEntry, registryEntry.source, options)
    : {
        status: 'resolved' as const,
        summary: 'Alias resolved successfully; package fetch/install is the next Phase 3 step.',
        nextAction: describeSource(registryEntry.source)
      };

  return {
    request,
    alias: registryEntry.alias,
    registryEntry,
    resolvedSource: registryEntry.source,
    materialization
  };
};

export const planCreateFromAlias = (registry: PodRegistry, request: PodCreateRequest): PodCreatePlan | undefined => {
  const registryEntry = registry.resolveAlias(request.alias);

  if (!registryEntry) {
    return undefined;
  }

  return {
    request,
    alias: registryEntry.alias,
    registryEntry,
    resolvedSource: registryEntry.source,
    materialization: {
      status: 'resolved',
      nextAction: describeSource(registryEntry.source),
      summary: 'Alias resolved successfully; package fetch/install is the next Phase 3 step.'
    }
  };
};
