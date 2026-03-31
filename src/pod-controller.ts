import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { SchedulingError } from './errors.js';
import { applyTemplateToCommand, applyTemplateToEnv, buildContext, type TemplateContext } from './path-template.js';
import {
  clearRpodPodId,
  executeViaRpod,
  getRpodPodId,
  rpodIsRunning,
  rpodRun,
  rpodStop,
  setRpodPodId
} from './rpod-adapter.js';
import type { HealthCheckConfig, PodLifecycleStatus, PodManifest, RpodRuntime } from './types.js';
import { sleep } from './utils.js';

const exec = promisify(execCb);

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_RPOD_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_RPOD_HEALTH_INTERVAL_MS = 1_000;
const DEFAULT_HTTP_HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_HEALTH_INTERVAL_MS = 500;

export interface LifecycleCommandResult {
  stdout: string;
  stderr: string;
}

interface PodRuntimeState {
  status: PodLifecycleStatus;
  currentJobId?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  /** Last lifecycle command output, for debugging. */
  lastLifecycleOutput?: LifecycleCommandResult;
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

  /** Get the last lifecycle command output for a pod, useful for debugging. */
  getLastLifecycleOutput(podId: string): LifecycleCommandResult | undefined {
    return this.states.get(podId)?.lastLifecycleOutput;
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

    if (manifest.runtime.kind === 'rpod') {
      const rpodRuntime = manifest.runtime as RpodRuntime;
      const podId = await rpodRun(rpodRuntime);
      setRpodPodId(manifest.id, podId);
    } else {
      await this.runLifecycleCommand(manifest.id, manifest.startup);
    }

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

    try {
      if (manifest.runtime.kind === 'rpod') {
        const rpodRuntime = manifest.runtime as RpodRuntime;
        const podId = getRpodPodId(manifest.id);
        if (podId) {
          await rpodStop(rpodRuntime, podId);
          clearRpodPodId(manifest.id);
        }
      } else {
        await this.runLifecycleCommand(manifest.id, manifest.shutdown);
      }
    } catch (error) {
      // Graceful degradation: log the error but still mark as stopped.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pod-controller] shutdown command failed for pod ${manifest.id}: ${message}`);
    }

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

  private async runLifecycleCommand(
    podId: string,
    step?: PodManifest['startup'] | PodManifest['shutdown'] | PodManifest['install'] | PodManifest['build']
  ): Promise<void> {
    if (!step) return;
    if (step.command) {
      const resolvedCommand = applyTemplateToCommand(step.command, this.templateCtx) ?? step.command;
      const resolvedEnv = applyTemplateToEnv(step.env, this.templateCtx);
      const timeoutMs = step.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;

      const { stdout, stderr } = await exec(resolvedCommand, {
        cwd: step.cwd,
        env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env,
        timeout: timeoutMs
      });

      // Store last output for debugging.
      const state = this.states.get(podId);
      if (state) {
        state.lastLifecycleOutput = { stdout: stdout ?? '', stderr: stderr ?? '' };
      }
    }
    if (step.simulatedDelayMs) {
      await sleep(step.simulatedDelayMs);
    }
  }

  private async waitForHealth(manifest: PodManifest): Promise<void> {
    if (manifest.runtime.kind === 'rpod') {
      const rpodRuntime = manifest.runtime as RpodRuntime;
      const podId = getRpodPodId(manifest.id);
      if (!podId) return; // nothing to wait for without a pod-id

      const hc: HealthCheckConfig = rpodRuntime.healthCheck ?? {};
      const timeoutMs = hc.timeoutMs ?? DEFAULT_RPOD_HEALTH_TIMEOUT_MS;
      const intervalMs = hc.intervalMs ?? DEFAULT_RPOD_HEALTH_INTERVAL_MS;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (await rpodIsRunning(rpodRuntime, podId)) {
          return;
        }
        await sleep(intervalMs);
      }
      throw new SchedulingError(
        `rpod health check timed out for pod ${manifest.id} (remote podId: ${podId}) on host ${rpodRuntime.host}`
      );
    }

    const healthPath = manifest.runtime.healthPath;
    if (!healthPath) return;

    const hc: HealthCheckConfig = manifest.runtime.healthCheck ?? {};
    const timeoutMs = hc.timeoutMs ?? DEFAULT_HTTP_HEALTH_TIMEOUT_MS;
    const intervalMs = hc.intervalMs ?? DEFAULT_HTTP_HEALTH_INTERVAL_MS;
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
    if (manifest.runtime.kind === 'rpod') {
      const rpodRuntime = manifest.runtime as RpodRuntime;
      const podId = getRpodPodId(manifest.id);
      if (!podId) return false;
      return rpodIsRunning(rpodRuntime, podId);
    }

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

  /**
   * Execute a job via the rpod adapter. Only valid for rpod-runtime manifests.
   * Returns the normalized job result.
   */
  async executeRpodJob(manifest: PodManifest, request: import('./types.js').JobRequest, context?: import('./types.js').RunContext): Promise<import('./types.js').JobCompletedResult> {
    if (manifest.runtime.kind !== 'rpod') {
      throw new SchedulingError(`executeRpodJob called on non-rpod manifest ${manifest.id}`);
    }
    return executeViaRpod(manifest, request, context);
  }
}
