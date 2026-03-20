import type { PodRegistry } from './registry.js';
import type {
  GithubRepoRegistrySource,
  LocalFileRegistrySource,
  PodRegistryIndexEntry,
  RegistryIndexRegistrySource,
  RegistrySource
} from './types.js';

export interface PodCreateRequest {
  alias: string;
}

export interface PodCreatePlan {
  status: 'resolved';
  request: PodCreateRequest;
  alias: string;
  registryEntry: PodRegistryIndexEntry;
  resolvedSource: RegistrySource;
  materialization: {
    status: 'not-implemented';
    nextAction: string;
    summary: string;
  };
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

export const planCreateFromAlias = (registry: PodRegistry, request: PodCreateRequest): PodCreatePlan | undefined => {
  const registryEntry = registry.resolveAlias(request.alias);

  if (!registryEntry) {
    return undefined;
  }

  return {
    status: 'resolved',
    request,
    alias: registryEntry.alias,
    registryEntry,
    resolvedSource: registryEntry.source,
    materialization: {
      status: 'not-implemented',
      nextAction: describeSource(registryEntry.source),
      summary: 'Alias resolved successfully; package fetch/install is the next Phase 3 step.'
    }
  };
};
