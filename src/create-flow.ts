import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { NotFoundError } from './errors.js';
import { parsePodPackageManifest } from './manifest-loader.js';
import type { InstalledPackageStore } from './installed-package-store.js';
import type { PodController } from './pod-controller.js';
import type { PodRegistry } from './registry.js';
import type {
  GithubRepoRegistrySource,
  GitRepoRegistrySource,
  InstalledPackageMetadata,
  LocalFileRegistrySource,
  PodRegistryIndexEntry,
  RegistryIndexRegistrySource,
  RegistrySource
} from './types.js';

export interface PodCreateRequest {
  alias?: string;
  source?: Exclude<RegistrySource, RegistryIndexRegistrySource>;
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
    case 'git-repo':
      return describeGitRepoSource(source);
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

const describeGitRepoSource = (source: GitRepoRegistrySource): string => {
  const refNote = source.ref ? ` at ref ${source.ref}` : '';
  const manifestNote = source.packageManifestPath
    ? ` and read ${source.packageManifestPath}`
    : '';
  return `Clone ${source.repoUrl}${refNote}${manifestNote}, validate the package manifest, then materialize it into managed storage.`;
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

const getManagedPackagesRoot = (options: CreateFromAliasOptions) =>
  options.managedPackagesRoot ?? path.resolve(options.projectRoot ?? process.cwd(), '.data/pod-packages');

const persistInstalledPackage = (
  registryEntry: PodRegistryIndexEntry,
  manifest: ReturnType<typeof parsePodPackageManifest>,
  source: RegistrySource,
  sourcePath: string,
  packageManifestPath: string,
  materializedPath: string,
  options: CreateFromAliasOptions,
  summaryPrefix: string
): MaterializedPodCreatePlan => {
  const installedPackage: InstalledPackageMetadata = {
    alias: registryEntry.alias,
    packageName: manifest.name,
    packageVersion: manifest.version,
    podId: manifest.pod.id,
    installedAt: new Date().toISOString(),
    source,
    sourcePath,
    packageManifestPath,
    materializedPath,
    manifest
  };

  if (!options.registry.get(manifest.pod.id)) {
    options.registry.register(manifest.pod);
    options.podController.syncManifest(manifest.pod);
  }
  options.installedPackageStore.upsert(installedPackage);

  return {
    status: 'installed',
    summary: `${summaryPrefix} ${manifest.name}@${manifest.version} for alias ${registryEntry.alias}.`,
    installedPackage
  };
};

const materializeLocalFilePackage = (
  registryEntry: PodRegistryIndexEntry,
  source: LocalFileRegistrySource,
  options: CreateFromAliasOptions
): MaterializedPodCreatePlan => {
  const projectRoot = options.projectRoot ?? process.cwd();
  const managedPackagesRoot = getManagedPackagesRoot(options);
  const { sourcePath, packageManifestPath } = resolveLocalSourcePaths(projectRoot, source);
  const manifest = parsePodPackageManifest(JSON.parse(readFileSync(packageManifestPath, 'utf8')));

  const managedAliasPath = path.join(managedPackagesRoot, registryEntry.alias);
  mkdirSync(managedPackagesRoot, { recursive: true });
  cpSync(sourcePath, managedAliasPath, { recursive: true, force: true });

  return persistInstalledPackage(
    registryEntry,
    manifest,
    source,
    sourcePath,
    packageManifestPath,
    managedAliasPath,
    options,
    'Installed local package'
  );
};

const toGithubCloneUrl = (source: GithubRepoRegistrySource) => `https://github.com/${source.repo}.git`;

const deriveAliasFromSource = (source: Exclude<RegistrySource, RegistryIndexRegistrySource>) => {
  if (source.kind === 'github-repo') {
    return source.repo.split('/').pop() ?? source.repo;
  }

  if (source.kind === 'git-repo') {
    const pathname = new URL(source.repoUrl).pathname.replace(/\/+$/, '');
    const basename = pathname.split('/').pop() ?? 'git-package';
    return basename.endsWith('.git') ? basename.slice(0, -4) : basename;
  }

  return path.basename(source.path);
};

const cloneAndMaterializeGitPackage = (
  registryEntry: PodRegistryIndexEntry,
  source: GithubRepoRegistrySource | GitRepoRegistrySource,
  options: CreateFromAliasOptions
): MaterializedPodCreatePlan => {
  const managedPackagesRoot = getManagedPackagesRoot(options);
  const cloneUrl = source.kind === 'github-repo' ? toGithubCloneUrl(source) : source.repoUrl;
  const checkoutRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-git-checkout-'));

  try {
    execFileSync('git', ['clone', '--depth', '1', cloneUrl, checkoutRoot], { stdio: 'pipe' });

    if (source.ref) {
      execFileSync('git', ['-C', checkoutRoot, 'checkout', source.ref], { stdio: 'pipe' });
    }

    const packageRoot = source.subpath ? path.join(checkoutRoot, source.subpath) : checkoutRoot;
    const manifestPath = path.join(packageRoot, source.packageManifestPath ?? 'pod-package.json');
    const manifest = parsePodPackageManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

    const managedAliasPath = path.join(managedPackagesRoot, registryEntry.alias);
    mkdirSync(managedPackagesRoot, { recursive: true });
    cpSync(packageRoot, managedAliasPath, { recursive: true, force: true });

    const materializedManifestPath = path.join(managedAliasPath, source.packageManifestPath ?? 'pod-package.json');

    return persistInstalledPackage(
      registryEntry,
      manifest,
      source,
      managedAliasPath,
      materializedManifestPath,
      managedAliasPath,
      options,
      source.kind === 'github-repo' ? 'Installed GitHub package' : 'Installed Git package'
    );
  } finally {
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
};

const materializeSource = (
  registryEntry: PodRegistryIndexEntry,
  source: Exclude<RegistrySource, RegistryIndexRegistrySource>,
  options: CreateFromAliasOptions
): MaterializedPodCreatePlan => {
  switch (source.kind) {
    case 'local-file':
      return materializeLocalFilePackage(registryEntry, source, options);
    case 'github-repo':
    case 'git-repo':
      return cloneAndMaterializeGitPackage(registryEntry, source, options);
  }
};

const resolveRequestToEntry = (request: PodCreateRequest, registry: PodRegistry): PodRegistryIndexEntry | undefined => {
  if (request.source) {
    const alias = request.alias ?? deriveAliasFromSource(request.source);
    return {
      alias,
      packageName: alias,
      source: request.source
    };
  }

  return request.alias ? registry.resolveAlias(request.alias) : undefined;
};

export const createFromAlias = (request: PodCreateRequest, options: CreateFromAliasOptions): PodCreatePlan => {
  const registryEntry = resolveRequestToEntry(request, options.registry);

  if (!registryEntry) {
    throw new NotFoundError(`Unknown pod alias: ${request.alias}`);
  }

  const materialization = registryEntry.source.kind === 'registry-index'
    ? {
        status: 'resolved' as const,
        summary: 'Alias resolved successfully; package fetch/install is the next Phase 3 step.',
        nextAction: describeSource(registryEntry.source)
      }
    : materializeSource(registryEntry, registryEntry.source, options);

  return {
    request,
    alias: registryEntry.alias,
    registryEntry,
    resolvedSource: registryEntry.source,
    materialization
  };
};

export const planCreateFromAlias = (registry: PodRegistry, request: PodCreateRequest): PodCreatePlan | undefined => {
  const registryEntry = resolveRequestToEntry(request, registry);

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
