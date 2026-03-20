import { SchedulingError } from './errors.js';
import type { PodLifecycleStatus, PodManifest } from './types.js';
import { sleep } from './utils.js';

interface PodRuntimeState {
  status: PodLifecycleStatus;
  currentJobId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface ManagedPodState extends PodRuntimeState {
  manifest: PodManifest;
}

export class PodController {
  private readonly states = new Map<string, PodRuntimeState>();

  constructor(manifests: PodManifest[]) {
    manifests.forEach((manifest) => {
      this.states.set(manifest.id, { status: 'stopped' });
    });
  }

  syncManifest(manifest: PodManifest): void {
    if (!this.states.has(manifest.id)) {
      this.states.set(manifest.id, { status: 'stopped' });
    }
  }

  getStatus(podId: string): PodLifecycleStatus {
    const state = this.states.get(podId);
    if (!state) {
      throw new SchedulingError(`Unknown pod: ${podId}`);
    }

    return state.status;
  }

  snapshot(manifests: PodManifest[]): ManagedPodState[] {
    return manifests.map((manifest) => ({
      manifest,
      ...(this.states.get(manifest.id) ?? { status: 'stopped' as const })
    }));
  }

  async start(manifest: PodManifest): Promise<void> {
    const state = this.requireState(manifest.id);
    if (state.status === 'running' || state.status === 'starting') {
      return;
    }

    state.status = 'starting';
    await sleep(manifest.startup?.simulatedDelayMs ?? 0);
    state.status = 'running';
    state.lastStartedAt = new Date().toISOString();
  }

  async stop(manifest: PodManifest): Promise<void> {
    const state = this.requireState(manifest.id);
    if (state.status === 'stopped' || state.status === 'stopping') {
      return;
    }

    if (state.currentJobId) {
      throw new SchedulingError(`Cannot stop pod ${manifest.id} while job ${state.currentJobId} is running`);
    }

    state.status = 'stopping';
    await sleep(manifest.shutdown?.simulatedDelayMs ?? 0);
    state.status = 'stopped';
    state.lastStoppedAt = new Date().toISOString();
  }

  async ensureExclusive(manifest: PodManifest, manifests: PodManifest[]): Promise<void> {
    if (!manifest.exclusivityGroup) {
      await this.start(manifest);
      return;
    }

    for (const candidate of manifests) {
      if (candidate.id === manifest.id || candidate.exclusivityGroup !== manifest.exclusivityGroup) {
        continue;
      }

      const state = this.requireState(candidate.id);
      if (state.status === 'running' && !state.currentJobId) {
        await this.stop(candidate);
      }
    }

    await this.start(manifest);
  }

  markJobStarted(podId: string, jobId: string): void {
    const state = this.requireState(podId);
    state.currentJobId = jobId;
    state.status = 'running';
  }

  markJobFinished(podId: string): void {
    const state = this.requireState(podId);
    state.currentJobId = undefined;
    if (state.status === 'stopping') {
      return;
    }
    state.status = 'running';
  }

  private requireState(podId: string): PodRuntimeState {
    const state = this.states.get(podId);
    if (!state) {
      throw new SchedulingError(`Unknown pod: ${podId}`);
    }

    return state;
  }
}
