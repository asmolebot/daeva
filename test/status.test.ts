import { describe, expect, it } from 'vitest';

import { InstalledPackageStore } from '../src/installed-package-store.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import { buildRuntimeStatus, buildStatusSnapshot } from '../src/status.js';
import type { RuntimeInspector } from '../src/runtime-inspector.js';
import { testManifests } from './helpers.js';

const makeFixture = () => {
  const registry = new PodRegistry(testManifests());
  const podController = new PodController(registry.list());
  const router = new SchedulerRouter(registry, podController);
  const jobManager = new JobManager(registry, podController, router);
  const installedPackageStore = new InstalledPackageStore();

  return { registry, podController, router, jobManager, installedPackageStore };
};

describe('runtime status inspection', () => {
  it('falls back cleanly when podman inspection is unavailable', () => {
    const { registry, podController } = makeFixture();
    const unavailableInspector: RuntimeInspector = {
      inspect() {
        return {
          backend: 'podman',
          available: false,
          error: 'spawn podman ENOENT',
          containersByName: new Map()
        };
      }
    };

    const status = buildRuntimeStatus(registry, podController, unavailableInspector);
    const whisper = status.pods.find((pod) => pod.podId === 'whisper');

    expect(status.inspection).toEqual({
      backend: 'podman',
      available: false,
      error: 'spawn podman ENOENT'
    });
    expect(status.summary.observedContainers).toBe(0);
    expect(whisper?.container).toEqual({
      declaredName: 'daeva-whisper',
      name: 'daeva-whisper',
      names: ['daeva-whisper'],
      image: null,
      state: null,
      status: null,
      ports: [],
      inferredFrom: 'startup.command',
      detection: 'manifest-hint'
    });
  });

  it('threads runtime inspection through the aggregate status snapshot', () => {
    const { registry, podController, jobManager, installedPackageStore } = makeFixture();
    const inspector: RuntimeInspector = {
      inspect() {
        return {
          backend: 'podman',
          available: true,
          containersByName: new Map([
            [
              'comfyapi',
              {
                name: 'comfyapi',
                names: ['comfyapi'],
                image: 'ghcr.io/saladtechnologies/comfyui-api:latest',
                state: 'exited',
                status: 'Exited (0) 2 hours ago',
                ports: []
              }
            ]
          ])
        };
      }
    };

    const snapshot = buildStatusSnapshot(registry, podController, jobManager, installedPackageStore, inspector);
    const comfy = snapshot.runtime.pods.find((pod) => pod.podId === 'comfyapi');

    expect(snapshot.runtime.inspection.available).toBe(true);
    expect(snapshot.runtime.summary.observedContainers).toBe(1);
    expect(comfy?.container.image).toBe('ghcr.io/saladtechnologies/comfyui-api:latest');
    expect(comfy?.container.state).toBe('exited');
    expect(comfy?.container.detection).toBe('podman');
  });
});
