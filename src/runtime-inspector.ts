import { spawnSync } from 'node:child_process';

import type { PodManifest } from './types.js';

export interface ContainerPortBinding {
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number | null;
  protocol: string | null;
}

export interface PodmanContainerObservation {
  name: string;
  names: string[];
  image: string | null;
  state: string | null;
  status: string | null;
  ports: ContainerPortBinding[];
}

export interface RuntimeInspectionResult {
  backend: 'podman';
  available: boolean;
  error?: string;
  containersByName: Map<string, PodmanContainerObservation>;
}

export interface RuntimeInspector {
  inspect(manifests: PodManifest[]): RuntimeInspectionResult;
}

const extractDeclaredContainerName = (command?: string): string | undefined => {
  if (!command) {
    return undefined;
  }

  const match = command.match(/(?:^|\s)--name\s+([^\s]+)/);
  return match?.[1]?.replace(/^['"`]+|['"`]+$/g, '');
};

const normalizePorts = (value: unknown): ContainerPortBinding[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return {
        hostIp: null,
        hostPort: null,
        containerPort: null,
        protocol: null
      };
    }

    const record = entry as Record<string, unknown>;
    const hostPort = record.host_port ?? record.hostPort;
    const containerPort = record.container_port ?? record.containerPort;
    const protocol = record.protocol;
    const hostIp = record.host_ip ?? record.hostIp;

    return {
      hostIp: typeof hostIp === 'string' ? hostIp : null,
      hostPort: typeof hostPort === 'number' ? hostPort : typeof hostPort === 'string' ? Number.parseInt(hostPort, 10) || null : null,
      containerPort:
        typeof containerPort === 'number'
          ? containerPort
          : typeof containerPort === 'string'
            ? Number.parseInt(containerPort, 10) || null
            : null,
      protocol: typeof protocol === 'string' ? protocol : null
    };
  });
};

const parsePsRecord = (value: unknown): PodmanContainerObservation | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const namesValue = record.Names ?? record.names;
  const names = Array.isArray(namesValue)
    ? namesValue.filter((entry): entry is string => typeof entry === 'string')
    : typeof namesValue === 'string'
      ? namesValue.split(',').map((name) => name.trim()).filter(Boolean)
      : [];
  const fallbackName = typeof record.Name === 'string' ? record.Name : typeof record.name === 'string' ? record.name : null;
  const name = names[0] ?? fallbackName;

  if (!name) {
    return null;
  }

  return {
    name,
    names,
    image: typeof record.Image === 'string' ? record.Image : typeof record.image === 'string' ? record.image : null,
    state: typeof record.State === 'string' ? record.State : typeof record.state === 'string' ? record.state : null,
    status: typeof record.Status === 'string' ? record.Status : typeof record.status === 'string' ? record.status : null,
    ports: normalizePorts(record.Ports ?? record.ports)
  };
};

export class PodmanRuntimeInspector implements RuntimeInspector {
  inspect(manifests: PodManifest[]): RuntimeInspectionResult {
    const declaredNames = manifests
      .map((manifest) => extractDeclaredContainerName(manifest.startup?.command))
      .filter((name): name is string => Boolean(name));

    if (declaredNames.length === 0) {
      return {
        backend: 'podman',
        available: true,
        containersByName: new Map()
      };
    }

    const args = ['ps', '-a', '--format', 'json'];
    for (const name of declaredNames) {
      args.push('--filter', `name=${name}`);
    }

    const result = spawnSync('podman', args, {
      encoding: 'utf8'
    });

    if (result.error) {
      return {
        backend: 'podman',
        available: false,
        error: result.error.message,
        containersByName: new Map()
      };
    }

    if (result.status !== 0) {
      return {
        backend: 'podman',
        available: false,
        error: result.stderr.trim() || result.stdout.trim() || `podman exited with status ${result.status}`,
        containersByName: new Map()
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      const records = Array.isArray(parsed) ? parsed : [];
      const containersByName = new Map<string, PodmanContainerObservation>();

      for (const record of records) {
        const container = parsePsRecord(record);
        if (!container) {
          continue;
        }

        for (const name of [container.name, ...container.names]) {
          containersByName.set(name, container);
        }
      }

      return {
        backend: 'podman',
        available: true,
        containersByName
      };
    } catch (error) {
      return {
        backend: 'podman',
        available: false,
        error: error instanceof Error ? error.message : 'Failed to parse podman output',
        containersByName: new Map()
      };
    }
  }
}

export const inferDeclaredContainerName = extractDeclaredContainerName;
