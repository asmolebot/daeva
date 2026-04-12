import { exec as execCb } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
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
import type { HealthCheckConfig, PodLifecycleStatus, PodManifest, RpodRuntime, SchedulerConfig } from './types.js';
import { sleep } from './utils.js';

const exec = promisify(execCb);

const normalizeShellCommand = (command: string): string => {
  const trimmed = command.trim();
  if (!trimmed || /\s/.test(trimmed)) return command;
  if (!trimmed.endsWith('.sh')) return command;
  try {
    accessSync(trimmed, constants.X_OK);
    return command;
  } catch {
    return `sh ${JSON.stringify(trimmed)}`;
  }
};

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
  activeJobIds: Set<string>;
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

  /** Scheduler configuration for hotSwapMode / autoFitPods behavior. */
  schedulerConfig?: SchedulerConfig;
}

export interface ManagedPodState {
  manifest: PodManifest;
  status: PodLifecycleStatus;
  /** First active job ID (backward compat). */
  currentJobId?: string;
  /** All active job IDs on this pod. */
  activeJobIds: string[];
  lastStartedAt?: string;
  lastStoppedAt?: string;
}

export class PodController {
  private readonly states = new Map<string, PodRuntimeState>();
  private readonly templateCtx: TemplateContext;
  private readonly podTemplateContexts = new Map<string, TemplateContext>();
  private readonly schedulerConfig: SchedulerConfig;

  constructor(manifests: PodManifest[], options: PodControllerOptions = {}) {
    this.templateCtx = buildContext(options.templateContext ?? {});
    this.schedulerConfig = options.schedulerConfig ?? {};
    manifests.forEach((manifest) => {
      this.states.set(manifest.id, { status: 'stopped', activeJobIds: new Set() });
    });
  }

  syncManifest(manifest: PodManifest, templateContext?: TemplateContext): void {
    if (!this.states.has(manifest.id)) {
      this.states.set(manifest.id, { status: 'stopped', activeJobIds: new Set() });
    }
    if (templateContext) {
      this.podTemplateContexts.set(manifest.id, buildContext({ ...this.templateCtx, ...templateContext }));
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

  /** Get the number of currently active jobs on a pod. */
  getActiveJobCount(podId: string): number {
    const state = this.states.get(podId);
    return state ? state.activeJobIds.size : 0;
  }

  snapshot(manifests: PodManifest[]): ManagedPodState[] {
    return manifests.map((manifest) => {
      const state = this.states.get(manifest.id) ?? { status: 'stopped' as const, activeJobIds: new Set<string>() };
      const ids = [...state.activeJobIds];
      return {
        manifest,
        status: state.status,
        currentJobId: ids[0],
        activeJobIds: ids,
        lastStartedAt: state.lastStartedAt,
        lastStoppedAt: state.lastStoppedAt,
      };
    });
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

    try {
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
    } catch (error) {
      await this.rollbackFailedStart(manifest);
      state.status = 'stopped';
      state.lastStoppedAt = new Date().toISOString();
      throw error;
    }
  }

  async stop(manifest: PodManifest): Promise<void> {
    const state = this.requireState(manifest.id);
    if (state.status === 'stopped' || state.status === 'stopping') {
      return;
    }

    if (state.activeJobIds.size > 0) {
      const jobList = [...state.activeJobIds].join(', ');
      throw new SchedulingError(`Cannot stop pod ${manifest.id} while ${state.activeJobIds.size} job(s) are running: ${jobList}`);
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

  async activate(manifest: PodManifest, manifests: PodManifest[]): Promise<void> {
    await this.ensureExclusive(manifest, manifests);
  }

  async swap(nextManifest: PodManifest, manifests: PodManifest[]): Promise<void> {
    await this.ensureExclusive(nextManifest, manifests);
  }

  async ensureExclusive(manifest: PodManifest, manifests: PodManifest[]): Promise<void> {
    if (!manifest.exclusivityGroup) {
      await this.start(manifest);
      return;
    }

    const targetState = this.states.get(manifest.id);

    // hotSwapMode: if the target pod is already running, skip tearing down
    // other pods — they may be needed again soon.
    if (this.schedulerConfig.hotSwapMode && targetState?.status === 'running') {
      return;
    }

    // Collect idle peers in the same exclusivity group.
    const idlePeers = manifests.filter((candidate) => {
      if (candidate.id === manifest.id) return false;
      if (candidate.exclusivityGroup !== manifest.exclusivityGroup) return false;
      const state = this.requireState(candidate.id);
      return state.status === 'running' && state.activeJobIds.size === 0;
    });

    if (this.schedulerConfig.autoFitPods && this.schedulerConfig.gpuCapacityMB) {
      // autoFitPods: only stop enough peers to make room for the new pod.
      await this.evictForCapacity(manifest, idlePeers, manifests);
    } else {
      // Default: stop ALL idle peers in the group (strict exclusivity).
      for (const peer of idlePeers) {
        await this.stop(peer);
      }
    }

    await this.start(manifest);
  }

  /**
   * Stop the minimum number of idle peers needed so that the incoming pod's
   * VRAM fits within the configured budget. Pods without a declared `vramMB`
   * are treated as consuming the entire budget (conservative fallback).
   */
  private async evictForCapacity(
    incoming: PodManifest,
    idlePeers: PodManifest[],
    allManifests: PodManifest[]
  ): Promise<void> {
    const budget = this.schedulerConfig.gpuCapacityMB!;
    const incomingVram = incoming.vramMB ?? budget;
    const group = incoming.exclusivityGroup!;
    const idleIds = new Set(idlePeers.map((p) => p.id));

    // Sum VRAM of all running same-group pods (excluding the incoming pod).
    let usedVram = 0;
    for (const m of allManifests) {
      if (m.id === incoming.id || m.exclusivityGroup !== group) continue;
      const state = this.states.get(m.id);
      if (state?.status !== 'running') continue;
      usedVram += m.vramMB ?? budget;
    }

    // If there's room, no eviction needed.
    if (usedVram + incomingVram <= budget) return;

    // Sort idle peers by VRAM descending — evict the biggest hogs first.
    const sortedPeers = [...idlePeers].sort(
      (a, b) => (b.vramMB ?? budget) - (a.vramMB ?? budget)
    );

    let reclaimed = 0;
    for (const peer of sortedPeers) {
      if (usedVram - reclaimed + incomingVram <= budget) break;
      await this.stop(peer);
      reclaimed += peer.vramMB ?? budget;
    }
  }

  markJobStarted(podId: string, jobId: string): void {
    const state = this.requireState(podId);
    state.activeJobIds.add(jobId);
    state.status = 'running';
  }

  markJobFinished(podId: string, jobId: string): void {
    const state = this.requireState(podId);
    state.activeJobIds.delete(jobId);
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
      const templateCtx = this.getTemplateContext(podId);
      const resolvedCommand = normalizeShellCommand(applyTemplateToCommand(step.command, templateCtx) ?? step.command);
      const resolvedEnv = applyTemplateToEnv(step.env, templateCtx);
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

  private getTemplateContext(podId: string): TemplateContext {
    return this.podTemplateContexts.get(podId) ?? this.templateCtx;
  }

  private async rollbackFailedStart(manifest: PodManifest): Promise<void> {
    try {
      if (manifest.runtime.kind === 'rpod') {
        const rpodRuntime = manifest.runtime as RpodRuntime;
        const podId = getRpodPodId(manifest.id);
        if (podId) {
          await rpodStop(rpodRuntime, podId);
          clearRpodPodId(manifest.id);
        }
        return;
      }

      if (manifest.shutdown) {
        await this.runLifecycleCommand(manifest.id, manifest.shutdown);
      }
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      console.error(`[pod-controller] rollback failed for pod ${manifest.id}: ${message}`);
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
