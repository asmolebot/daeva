import { copyFileSync, cpSync, lstatSync, mkdtempSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { runInstallHooks, type InstallHookOptions } from './install-hooks.js';

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
  RegistrySource,
  UploadedArchiveRegistrySource
} from './types.js';

export interface PodCreateRequest {
  alias?: string;
  source?: Exclude<RegistrySource, RegistryIndexRegistrySource>;
}

export interface MaterializedPodCreatePlan {
  status: 'installed';
  summary: string;
  installedPackage: InstalledPackageMetadata;
  /**
   * Human-readable description of install hook steps that ran or would run.
   * Present when install hooks were executed or when hook descriptions are available.
   */
  installHookSteps?: string[];
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
  /**
   * Reserved for future opt-out behavior. Install hooks currently run as part of
   * package materialization so resolved host paths are persisted consistently.
   */
  runInstallHooks?: boolean;
  /**
   * Options forwarded to the install hook runner.
   */
  installHookOptions?: InstallHookOptions;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_ENTRIES = 2000;
const SAFE_ARCHIVE_EXTENSIONS = ['.tar', '.tar.gz', '.tgz', '.zip'];

const describeSource = (source: RegistrySource): string => {
  switch (source.kind) {
    case 'local-file':
      return describeLocalFileSource(source);
    case 'github-repo':
      return describeGithubRepoSource(source);
    case 'git-repo':
      return describeGitRepoSource(source);
    case 'uploaded-archive':
      return describeUploadedArchiveSource(source);
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

const describeUploadedArchiveSource = (source: UploadedArchiveRegistrySource): string => {
  const manifestNote = source.packageManifestPath
    ? ` and read ${source.packageManifestPath}`
    : '';
  return `Unpack uploaded archive ${source.filename}${manifestNote}, validate the package manifest, then materialize it into managed storage. Current limits: ${Math.floor(MAX_ARCHIVE_BYTES / (1024 * 1024))} MiB compressed, ${Math.floor(MAX_EXTRACTED_BYTES / (1024 * 1024))} MiB extracted, ${MAX_EXTRACTED_ENTRIES} extracted entries.`;
};

const describeRegistryIndexSource = (source: RegistryIndexRegistrySource): string =>
  `Fetch registry index ${source.indexUrl}, resolve alias ${source.alias}, then continue materialization from the delegated source.`;

const assertRelativeSubpath = (value: string | undefined, fieldName: string) => {
  if (!value) {
    return;
  }

  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`${fieldName} must stay within the extracted package root`);
  }
};

const safeJoinWithin = (root: string, relativePath: string, fieldName: string) => {
  assertRelativeSubpath(relativePath, fieldName);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} escapes the package root`);
  }
  return candidate;
};

const assertArchiveFilename = (filename: string) => {
  const basename = path.basename(filename);
  if (basename !== filename) {
    throw new Error('uploaded archive filename must not include path separators');
  }
  if (!SAFE_ARCHIVE_EXTENSIONS.some((extension) => basename.toLowerCase().endsWith(extension))) {
    throw new Error('Unsupported uploaded archive format. First pass supports .tar, .tar.gz, .tgz, and .zip.');
  }
};

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

const persistInstalledPackage = async (
  registryEntry: PodRegistryIndexEntry,
  manifest: ReturnType<typeof parsePodPackageManifest>,
  source: RegistrySource,
  sourcePath: string,
  packageManifestPath: string,
  materializedPath: string,
  options: CreateFromAliasOptions,
  summaryPrefix: string
): Promise<MaterializedPodCreatePlan> => {
  const hookResult = await runInstallHooks(manifest, materializedPath, {
    ...options.installHookOptions,
    dryRun: options.installHookOptions?.dryRun ?? false,
    skipPodmanSteps: options.installHookOptions?.skipPodmanSteps ?? false
  });

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
    manifest,
    resolvedTemplateContext: hookResult.templateContext,
    resolvedDirectories: hookResult.resolvedDirectories
  };

  if (!options.registry.get(manifest.pod.id)) {
    options.registry.register(manifest.pod);
  }
  options.podController.syncManifest(manifest.pod, hookResult.templateContext);
  options.installedPackageStore.upsert(installedPackage);

  return {
    status: 'installed',
    summary: `${summaryPrefix} ${manifest.name}@${manifest.version} for alias ${registryEntry.alias}.`,
    installedPackage,
    installHookSteps: hookResult.steps.map((step) => `${step.status}: ${step.description}${step.detail ? ` (${step.detail})` : ''}`)
  };
};

const materializeLocalFilePackage = async (
  registryEntry: PodRegistryIndexEntry,
  source: LocalFileRegistrySource,
  options: CreateFromAliasOptions
): Promise<MaterializedPodCreatePlan> => {
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

  if (source.kind === 'uploaded-archive') {
    return source.filename.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '') || 'uploaded-package';
  }

  return path.basename(source.path);
};

const cloneAndMaterializeGitPackage = async (
  registryEntry: PodRegistryIndexEntry,
  source: GithubRepoRegistrySource | GitRepoRegistrySource,
  options: CreateFromAliasOptions
): Promise<MaterializedPodCreatePlan> => {
  const managedPackagesRoot = getManagedPackagesRoot(options);
  const cloneUrl = source.kind === 'github-repo' ? toGithubCloneUrl(source) : source.repoUrl;
  const checkoutRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-git-checkout-'));

  try {
    execFileSync('git', ['clone', '--depth', '1', cloneUrl, checkoutRoot], { stdio: 'pipe' });

    if (source.ref) {
      execFileSync('git', ['-C', checkoutRoot, 'checkout', source.ref], { stdio: 'pipe' });
    }

    const packageRoot = source.subpath ? safeJoinWithin(checkoutRoot, source.subpath, 'source.subpath') : checkoutRoot;
    const manifestPath = source.packageManifestPath
      ? safeJoinWithin(packageRoot, source.packageManifestPath, 'source.packageManifestPath')
      : path.join(packageRoot, 'pod-package.json');
    const manifest = parsePodPackageManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

    const managedAliasPath = path.join(managedPackagesRoot, registryEntry.alias);
    mkdirSync(managedPackagesRoot, { recursive: true });
    cpSync(packageRoot, managedAliasPath, { recursive: true, force: true });

    const materializedManifestPath = source.packageManifestPath
      ? safeJoinWithin(managedAliasPath, source.packageManifestPath, 'source.packageManifestPath')
      : path.join(managedAliasPath, 'pod-package.json');

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

const writeUploadedArchive = (source: UploadedArchiveRegistrySource, archivePath: string) => {
  assertArchiveFilename(source.filename);

  // Multipart path: archive already streamed to disk
  if (source.archivePath) {
    const stats = statSync(source.archivePath);
    if (stats.size === 0) {
      throw new Error('uploaded archive payload decoded to zero bytes');
    }
    if (stats.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`uploaded archive exceeds ${Math.floor(MAX_ARCHIVE_BYTES / (1024 * 1024))} MiB limit`);
    }
    copyFileSync(source.archivePath, archivePath);
    return;
  }

  // JSON/base64 path
  const normalized = source.archiveBase64.includes(',')
    ? source.archiveBase64.split(',').pop() ?? source.archiveBase64
    : source.archiveBase64;
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0) {
    throw new Error('uploaded archive payload decoded to zero bytes');
  }
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`uploaded archive exceeds ${Math.floor(MAX_ARCHIVE_BYTES / (1024 * 1024))} MiB limit`);
  }
  writeFileSync(archivePath, bytes);
};

const listArchiveEntries = (archivePath: string): string[] => {
  if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
    return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', stdio: 'pipe' }).split(/\r?\n/).filter(Boolean);
  }
  if (/\.tar$/i.test(archivePath)) {
    return execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8', stdio: 'pipe' }).split(/\r?\n/).filter(Boolean);
  }
  if (/\.zip$/i.test(archivePath)) {
    return execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8', stdio: 'pipe' }).split(/\r?\n/).filter(Boolean);
  }

  throw new Error('Unsupported uploaded archive format. First pass supports .tar, .tar.gz, .tgz, and .zip.');
};

const assertSafeArchiveEntries = (entries: string[]) => {
  if (entries.length === 0) {
    throw new Error('uploaded archive did not contain any entries');
  }
  if (entries.length > MAX_EXTRACTED_ENTRIES) {
    throw new Error(`uploaded archive exceeds ${MAX_EXTRACTED_ENTRIES} entry limit`);
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (!normalized || normalized === '.') {
      continue;
    }
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
      throw new Error(`uploaded archive contains an absolute path: ${entry}`);
    }
    const safe = path.posix.normalize(normalized);
    if (safe.startsWith('../') || safe.includes('/../')) {
      throw new Error(`uploaded archive contains a path traversal entry: ${entry}`);
    }
  }
};

const unpackArchive = (archivePath: string, extractRoot: string) => {
  const entries = listArchiveEntries(archivePath);
  assertSafeArchiveEntries(entries);

  if (/\.(tar\.gz|tgz)$/i.test(archivePath)) {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractRoot], { stdio: 'pipe' });
    return;
  }
  if (/\.tar$/i.test(archivePath)) {
    execFileSync('tar', ['-xf', archivePath, '-C', extractRoot], { stdio: 'pipe' });
    return;
  }
  if (/\.zip$/i.test(archivePath)) {
    execFileSync('unzip', ['-q', archivePath, '-d', extractRoot], { stdio: 'pipe' });
    return;
  }

  throw new Error('Unsupported uploaded archive format. First pass supports .tar, .tar.gz, .tgz, and .zip.');
};

const inspectExtractedTree = (root: string) => {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (current: string) => {
    const directory = opendirSync(current);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        const fullPath = path.join(current, entry.name);
        const relative = path.relative(root, fullPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`extracted path escaped root: ${entry.name}`);
        }

        const stats = lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          throw new Error(`uploaded archive contains unsupported symlink entry: ${relative}`);
        }
        if (stats.isDirectory()) {
          fileCount += 1;
          if (fileCount > MAX_EXTRACTED_ENTRIES) {
            throw new Error(`uploaded archive exceeds ${MAX_EXTRACTED_ENTRIES} extracted entry limit`);
          }
          walk(fullPath);
          continue;
        }
        if (stats.isFile()) {
          fileCount += 1;
          totalBytes += stats.size;
          if (fileCount > MAX_EXTRACTED_ENTRIES) {
            throw new Error(`uploaded archive exceeds ${MAX_EXTRACTED_ENTRIES} extracted entry limit`);
          }
          if (totalBytes > MAX_EXTRACTED_BYTES) {
            throw new Error(`uploaded archive exceeds ${Math.floor(MAX_EXTRACTED_BYTES / (1024 * 1024))} MiB extracted size limit`);
          }
          continue;
        }

        throw new Error(`uploaded archive contains unsupported entry type: ${relative}`);
      }
    } finally {
      directory.closeSync();
    }
  };

  walk(root);
};

const materializeUploadedArchivePackage = async (
  registryEntry: PodRegistryIndexEntry,
  source: UploadedArchiveRegistrySource,
  options: CreateFromAliasOptions
): Promise<MaterializedPodCreatePlan> => {
  const managedPackagesRoot = getManagedPackagesRoot(options);
  const unpackRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-pod-upload-'));
  const archivePath = path.join(unpackRoot, path.basename(source.filename));
  const extractedRoot = path.join(unpackRoot, 'extracted');
  mkdirSync(extractedRoot, { recursive: true });

  try {
    writeUploadedArchive(source, archivePath);
    unpackArchive(archivePath, extractedRoot);
    inspectExtractedTree(extractedRoot);

    const packageRoot = source.subpath ? safeJoinWithin(extractedRoot, source.subpath, 'source.subpath') : extractedRoot;
    if (!statSync(packageRoot).isDirectory()) {
      throw new Error('source.subpath must resolve to an extracted directory');
    }
    const manifestPath = source.packageManifestPath
      ? safeJoinWithin(packageRoot, source.packageManifestPath, 'source.packageManifestPath')
      : path.join(packageRoot, 'pod-package.json');
    const manifest = parsePodPackageManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

    const managedAliasPath = path.join(managedPackagesRoot, registryEntry.alias);
    mkdirSync(managedPackagesRoot, { recursive: true });
    cpSync(packageRoot, managedAliasPath, { recursive: true, force: true });

    const materializedManifestPath = source.packageManifestPath
      ? safeJoinWithin(managedAliasPath, source.packageManifestPath, 'source.packageManifestPath')
      : path.join(managedAliasPath, 'pod-package.json');

    return persistInstalledPackage(
      registryEntry,
      manifest,
      source,
      managedAliasPath,
      materializedManifestPath,
      managedAliasPath,
      options,
      'Installed uploaded archive package'
    );
  } finally {
    rmSync(unpackRoot, { recursive: true, force: true });
  }
};

const materializeSource = async (
  registryEntry: PodRegistryIndexEntry,
  source: Exclude<RegistrySource, RegistryIndexRegistrySource>,
  options: CreateFromAliasOptions
): Promise<MaterializedPodCreatePlan> => {
  switch (source.kind) {
    case 'local-file':
      return materializeLocalFilePackage(registryEntry, source, options);
    case 'github-repo':
    case 'git-repo':
      return cloneAndMaterializeGitPackage(registryEntry, source, options);
    case 'uploaded-archive':
      return materializeUploadedArchivePackage(registryEntry, source, options);
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

export const createFromAlias = async (request: PodCreateRequest, options: CreateFromAliasOptions): Promise<PodCreatePlan> => {
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
    : await materializeSource(registryEntry, registryEntry.source, options);

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
