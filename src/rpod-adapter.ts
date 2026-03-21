/**
 * rpod-adapter.ts
 *
 * Wraps the `rpod` CLI for remote GPU pod execution.
 *
 * Supported rpod commands:
 *   rpod discover [--host <host>]               → list available remote pods/devices
 *   rpod run --host <host> [--device <device>]  → start a pod and return its pod-id
 *   rpod stop --host <host> <pod-id>            → stop a running pod
 *   rpod exec --host <host> <pod-id> -- <cmd>   → execute a command inside a pod
 *   rpod ps   [--host <host>]                   → list running pods
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { AppError } from './errors.js';
import type { JobCompletedResult, JobRequest, PodManifest, RpodRuntime, RunContext } from './types.js';
import { inferCapabilityForJobType, normalizeCompletedResult } from './job-contracts.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Low-level CLI wrapper types
// ---------------------------------------------------------------------------

export interface RpodDiscoverEntry {
  host: string;
  podId?: string;
  device?: string;
  status?: string;
  meta?: Record<string, unknown>;
}

export interface RpodPsEntry {
  podId: string;
  host: string;
  device?: string;
  status: string;
  startedAt?: string;
  image?: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function rpodBin(runtime: RpodRuntime): string {
  return runtime.command ?? 'rpod';
}

function buildHostArgs(runtime: RpodRuntime): string {
  return `--host ${shellEscape(runtime.host)}`;
}

function buildDeviceArg(runtime: RpodRuntime): string {
  if (!runtime.device) return '';
  return `--device ${shellEscape(runtime.device)}`;
}

function shellEscape(value: string): string {
  // Simple single-quote escape for shell arguments
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runRpod(cmd: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(cmd, { timeout: timeoutMs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(`rpod CLI error: ${msg}`, { code: 'RPOD_CLI_ERROR', type: 'pod-request', retriable: false, details: { cmd } });
  }
}

function tryParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// High-level rpod operations
// ---------------------------------------------------------------------------

/**
 * Discover available pods/devices on the remote host.
 */
export async function rpodDiscover(runtime: RpodRuntime): Promise<RpodDiscoverEntry[]> {
  const bin = rpodBin(runtime);
  const hostArgs = buildHostArgs(runtime);
  const { stdout } = await runRpod(`${bin} discover ${hostArgs} --output json`);
  const parsed = tryParseJson<RpodDiscoverEntry[]>(stdout);
  return parsed ?? [];
}

/**
 * Start a remote pod.  Returns the pod-id assigned by rpod.
 */
export async function rpodRun(runtime: RpodRuntime, image?: string): Promise<string> {
  const bin = rpodBin(runtime);
  const hostArgs = buildHostArgs(runtime);
  const deviceArg = buildDeviceArg(runtime);
  const imageArg = image ? shellEscape(image) : '';
  const cmd = [bin, 'run', hostArgs, deviceArg, imageArg, '--output json'].filter(Boolean).join(' ');
  const { stdout } = await runRpod(cmd);
  const parsed = tryParseJson<{ podId?: string; id?: string }>(stdout);
  const podId = parsed?.podId ?? parsed?.id;
  if (!podId) {
    throw new AppError(
      `rpod run did not return a pod-id. stdout: ${stdout.slice(0, 200)}`,
      { code: 'RPOD_NO_POD_ID', type: 'pod-request', retriable: true }
    );
  }
  return podId;
}

/**
 * Stop a running remote pod.
 */
export async function rpodStop(runtime: RpodRuntime, podId: string): Promise<void> {
  const bin = rpodBin(runtime);
  const hostArgs = buildHostArgs(runtime);
  await runRpod(`${bin} stop ${hostArgs} ${shellEscape(podId)}`);
}

/**
 * Execute a command inside a running remote pod.
 * Returns the combined stdout output.
 */
export async function rpodExec(
  runtime: RpodRuntime,
  podId: string,
  command: string,
  opts?: { timeoutMs?: number }
): Promise<string> {
  const bin = rpodBin(runtime);
  const hostArgs = buildHostArgs(runtime);
  const timeoutMs =
    opts?.timeoutMs ?? (runtime.execOptions?.timeoutSecs ? runtime.execOptions.timeoutSecs * 1000 : undefined);

  // Build env args from execOptions
  const envArgs = Object.entries(runtime.execOptions?.env ?? {})
    .map(([k, v]) => `-e ${shellEscape(`${k}=${v}`)}`)
    .join(' ');

  const cmd = [bin, 'exec', hostArgs, envArgs, shellEscape(podId), '--', command]
    .filter(Boolean)
    .join(' ');

  const { stdout } = await runRpod(cmd, timeoutMs);
  return stdout;
}

/**
 * List running pods, optionally filtered to the configured host.
 */
export async function rpodPs(runtime: RpodRuntime): Promise<RpodPsEntry[]> {
  const bin = rpodBin(runtime);
  const hostArgs = buildHostArgs(runtime);
  const { stdout } = await runRpod(`${bin} ps ${hostArgs} --output json`);
  const parsed = tryParseJson<RpodPsEntry[]>(stdout);
  return parsed ?? [];
}

/**
 * Check whether a specific pod-id is listed as running in `rpod ps`.
 */
export async function rpodIsRunning(runtime: RpodRuntime, podId: string): Promise<boolean> {
  try {
    const entries = await rpodPs(runtime);
    return entries.some((e) => e.podId === podId && e.status === 'running');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PodAdapter-compatible execute wrapper
// ---------------------------------------------------------------------------

/**
 * State bag stored per-manifest for rpod-backed pods.
 * The pod-id assigned by `rpod run` is needed for subsequent exec/stop calls.
 */
const rpodPodIds = new Map<string, string>();

export function setRpodPodId(manifestId: string, podId: string): void {
  rpodPodIds.set(manifestId, podId);
}

export function getRpodPodId(manifestId: string): string | undefined {
  return rpodPodIds.get(manifestId);
}

export function clearRpodPodId(manifestId: string): void {
  rpodPodIds.delete(manifestId);
}

/**
 * Execute a job request against a remote rpod pod.
 * The job payload is serialized to JSON and forwarded via `rpod exec`.
 */
export async function executeViaRpod(
  manifest: PodManifest,
  request: JobRequest,
  context?: RunContext
): Promise<JobCompletedResult> {
  const runtime = manifest.runtime as RpodRuntime;
  const podId = getRpodPodId(manifest.id);
  if (!podId) {
    throw new AppError(
      `No active rpod pod-id for manifest ${manifest.id}. Was the pod started?`,
      { code: 'RPOD_NOT_STARTED', type: 'pod-request', retriable: false }
    );
  }

  const capability = request.capability ?? inferCapabilityForJobType(request.type);
  const payloadJson = JSON.stringify({ type: request.type, capability, input: request.input });

  // Abort support: wrap in a race if signal is provided
  const execPromise = rpodExec(runtime, podId, `run-job ${shellEscape(payloadJson)}`, {
    timeoutMs: runtime.execOptions?.timeoutSecs ? runtime.execOptions.timeoutSecs * 1000 : undefined
  });

  let stdout: string;
  if (context?.signal) {
    stdout = await Promise.race([
      execPromise,
      new Promise<never>((_, reject) => {
        context.signal!.addEventListener('abort', () => reject(new AppError('Job aborted', { code: 'JOB_ABORTED', type: 'job-execution', retriable: false })));
      })
    ]);
  } else {
    stdout = await execPromise;
  }

  const response = tryParseJson<unknown>(stdout) ?? stdout;

  return normalizeCompletedResult(manifest, request, capability, {
    acceptedAt: new Date().toISOString(),
    submitUrl: `rpod://${runtime.host}/${podId}`,
    method: 'POST',
    bodyKind: 'json',
    response
  });
}
