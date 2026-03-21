import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { SchedulingError } from './errors.js';
import { applyTemplateToCommand, applyTemplateToEnv, buildContext, type TemplateContext } from './path-template.js';
import type { PodLifecycleStatus, PodManifest } from './types.js';
import { sleep } from './utils.js';

const exec = promisify(execCb);

interface PodRuntimeState {
  status: PodLifecycleStatus;
  currentJobId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export interface PodControllerOptions {
  /**
   * Template context applied to all lifecycle command strings before execution.
   * Built-in defaults (HOME, USER) are always included; these values override them.
   * Useful for passing PACKAGE_DIR or per-host overrides.
   */
  templateContext?: TemplateContext;
}

export interface ManagedPodState extends PodRuntimeState {
  manifest: PodManifest;
}

export class PodController {
  private readonly states = new Map<string, PodRuntimeState>();
  private readonly templateCtx: TemplateContext;

  constructor(manifests: PodManifest[], options: PodControllerOptions = {}) {
    this.templateCtx = buildContext(options.templateContext ?? {});
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

    if (await this.isHealthy(manifest)) {
      state.status = 'running';
      state.lastStartedAt = new Date().toISOString();
      return;
    }

    state.status = 'starting';
    await this.runLifecycleCommand(manifest.startup);
    await this.waitForHealth(manifest);
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
    await this.runLifecycleCommand(manifest.shutdown);
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

  private async runLifecycleCommand(step?: PodManifest['startup'] | PodManifest['shutdown'] | PodManifest['install'] | PodManifest['build']): Promise<void> {
    if (!step) return;
    if (step.command) {
      const resolvedCommand = applyTemplateToCommand(step.command, this.templateCtx) ?? step.command;
      const resolvedEnv = applyTemplateToEnv(step.env, this.templateCtx);
      await exec(resolvedCommand, {
        cwd: step.cwd,
        env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env
      });
    }
    if (step.simulatedDelayMs) {
      await sleep(step.simulatedDelayMs);
    }
  }

  private async waitForHealth(manifest: PodManifest): Promise<void> {
    const healthPath = manifest.runtime.healthPath;
    if (!healthPath) return;

    const timeoutMs = 15000;
    const intervalMs = 500;
    const deadline = Date.now() + timeoutMs;
    const url = `${manifest.runtime.baseUrl}${healthPath}`;

    while (Date.now() < deadline) {
      if (await this.isHealthy(manifest)) {
        return;
      }
      await sleep(intervalMs);
    }

    throw new SchedulingError(`Health check did not pass for pod ${manifest.id} at ${url}`);
  }

  private async isHealthy(manifest: PodManifest): Promise<boolean> {
    const healthPath = manifest.runtime.healthPath;
    if (!healthPath) {
      return true;
    }

    try {
      const response = await fetch(`${manifest.runtime.baseUrl}${healthPath}`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }
}
