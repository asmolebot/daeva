/**
 * install-hooks.ts
 *
 * Real install-time hooks for pod packages.
 *
 * Responsibilities:
 *   1. Create host directories declared in `manifest.directories[]` (those with createIfMissing: true).
 *   2. Run the `install` lifecycle command if the pod manifest defines one.
 *   3. For Podman-based strategies, issue real Podman commands:
 *        - `prebuilt-image` → `podman pull <image>`
 *        - `dockerfile`     → `podman build -t <imageName> <packageDir>`
 *
 * Template variables are applied to all paths and commands before execution
 * using the path-template module.  Unknown variables remain unreplaced.
 *
 * Install hooks are intentionally best-effort for the image-pull/build steps:
 * if Podman is unavailable the step is skipped with a warning rather than
 * failing the install, because many environments run containers differently
 * (rootless, remote daemon, Compose, etc.).
 *
 * The `install` lifecycle command (if present) is always executed as a hard
 * requirement — errors there propagate to the caller.
 */

import { accessSync, constants, mkdirSync } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import type { InstalledPackageResolvedDirectory, PodPackageManifest } from './types.js';
import { applyTemplate, applyTemplateToCommand, applyTemplateToEnv, applyTemplateToPath, buildPackageTemplateContext, type TemplateContext } from './path-template.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InstallHookStepKind =
  | 'mkdir'
  | 'podman-pull'
  | 'podman-build'
  | 'install-command';

export type InstallHookStepStatus = 'ok' | 'skipped' | 'error';

export interface InstallHookStep {
  kind: InstallHookStepKind;
  description: string;
  status: InstallHookStepStatus;
  /** Human-readable output or error detail. */
  detail?: string;
}

export interface InstallHookOptions {
  /**
   * Extra template context to merge on top of the built-in defaults.
   * Useful for passing PACKAGE_DIR, DATA_DIR, or custom variables.
   */
  templateContext?: TemplateContext;
  /**
   * When true, log steps but do not actually run Podman or shell commands.
   * Directory creation still happens so that the pod can start afterwards.
   */
  dryRun?: boolean;
  /** If true, skip the podman pull/build steps (dirs + install command still run). */
  skipPodmanSteps?: boolean;
}

export interface InstallHookResult {
  steps: InstallHookStep[];
  /** True when all required steps succeeded (warnings/skips don't fail this). */
  ok: boolean;
  templateContext: Record<string, string>;
  resolvedDirectories: InstalledPackageResolvedDirectory[];
}

// ---------------------------------------------------------------------------
// Image name extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a container image reference from the pod manifest.
 * We look in (in priority order):
 *  1. manifest.service.quadlet.image   (explicit quadlet metadata)
 *  2. The --replace / podman run image arg in startup.command  (heuristic)
 */
const extractImageName = (manifest: PodPackageManifest): string | undefined => {
  // 1. Explicit quadlet metadata
  const quadletImage = (manifest.service as { quadlet?: { image?: string } } | undefined)?.quadlet?.image;
  if (quadletImage) return quadletImage;

  // 2. Heuristic: last non-flag token after `podman run` in startup command
  const command = manifest.pod.startup?.command;
  if (!command) return undefined;

  // Grab the segment after "podman run" and find the last positional arg (image ref)
  const runMatch = command.match(/podman\s+run\s+(.*?)(?:'|"|\s*$)/s);
  if (!runMatch) return undefined;

  const args = runMatch[1].trim().split(/\s+/);
  // Walk backwards; skip flags and their arguments
  let skipNext = false;
  const flagsWithArgs = new Set([
    '--name', '--device', '-p', '--publish', '-v', '--volume',
    '-e', '--env', '--network', '--user', '--workdir', '-w',
    '--entrypoint', '--restart', '--label', '-l', '--hostname',
    '--add-host', '--dns', '--cap-add', '--cap-drop', '--security-opt',
    '--runtime', '--cgroup', '--cgroupns', '--pid', '--ipc', '--userns',
    '--memory', '--cpus', '--gpus', '--shm-size'
  ]);

  for (let i = args.length - 1; i >= 0; i--) {
    const token = args[i];
    if (skipNext) { skipNext = false; continue; }
    if (!token || token === '--replace') continue;
    if (token.startsWith('-')) {
      if (flagsWithArgs.has(token)) skipNext = true;
      continue;
    }
    // Looks like the image name
    return token.replace(/['"`]/g, '');
  }

  return undefined;
};

/**
 * Derive a sensible image tag for `podman build` from the package manifest.
 * Falls back to `<packageName>:latest`.
 */
const deriveImageTag = (manifest: PodPackageManifest): string => {
  const quadletImage = (manifest.service as { quadlet?: { image?: string } } | undefined)?.quadlet?.image;
  if (quadletImage) return quadletImage;
  return `${manifest.name}:${manifest.version}`;
};

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

const mkdirStep = (resolvedPath: string): InstallHookStep => {
  try {
    mkdirSync(resolvedPath, { recursive: true });
    return {
      kind: 'mkdir',
      description: `Created directory: ${resolvedPath}`,
      status: 'ok'
    };
  } catch (error) {
    return {
      kind: 'mkdir',
      description: `Failed to create directory: ${resolvedPath}`,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error)
    };
  }
};

const podmanPullStep = async (image: string, dryRun: boolean): Promise<InstallHookStep> => {
  const description = `podman pull ${image}`;
  if (dryRun) {
    return { kind: 'podman-pull', description, status: 'skipped', detail: 'dry-run' };
  }
  try {
    const { stdout, stderr } = await exec(`podman pull ${JSON.stringify(image)}`);
    return {
      kind: 'podman-pull',
      description,
      status: 'ok',
      detail: (stdout + stderr).trim() || undefined
    };
  } catch (error) {
    // Best-effort: skip rather than hard-fail
    return {
      kind: 'podman-pull',
      description,
      status: 'skipped',
      detail: `Podman pull skipped (${error instanceof Error ? error.message : String(error)}). You may need to pull the image manually.`
    };
  }
};

const podmanBuildStep = async (tag: string, packageDir: string, dryRun: boolean): Promise<InstallHookStep> => {
  const description = `podman build -t ${tag} ${packageDir}`;
  if (dryRun) {
    return { kind: 'podman-build', description, status: 'skipped', detail: 'dry-run' };
  }
  try {
    const { stdout, stderr } = await exec(`podman build -t ${JSON.stringify(tag)} ${JSON.stringify(packageDir)}`);
    return {
      kind: 'podman-build',
      description,
      status: 'ok',
      detail: (stdout + stderr).trim() || undefined
    };
  } catch (error) {
    return {
      kind: 'podman-build',
      description,
      status: 'skipped',
      detail: `Podman build skipped (${error instanceof Error ? error.message : String(error)}). You may need to build the image manually.`
    };
  }
};

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

const installCommandStep = async (
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  dryRun: boolean
): Promise<InstallHookStep> => {
  const normalizedCommand = normalizeShellCommand(command);
  const description = `install command: ${normalizedCommand.slice(0, 120)}${normalizedCommand.length > 120 ? '…' : ''}`;
  if (dryRun) {
    return { kind: 'install-command', description, status: 'skipped', detail: 'dry-run' };
  }
  try {
    const { stdout, stderr } = await exec(normalizedCommand, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env
    });
    return {
      kind: 'install-command',
      description,
      status: 'ok',
      detail: (stdout + stderr).trim() || undefined
    };
  } catch (error) {
    // install command failures are hard errors
    throw new Error(
      `Install command failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run install-time hooks for a materialized pod package.
 *
 * @param manifest     The parsed pod-package manifest.
 * @param packagePath  Absolute path to the materialized package directory.
 * @param options      Optional configuration (templateContext, dryRun, skipPodmanSteps).
 */
export async function runInstallHooks(
  manifest: PodPackageManifest,
  packagePath: string,
  options: InstallHookOptions = {}
): Promise<InstallHookResult> {
  const { dryRun = false, skipPodmanSteps = false } = options;
  const ctx = buildPackageTemplateContext(manifest, packagePath, options.templateContext);

  const steps: InstallHookStep[] = [];
  const resolvedDirectories: InstalledPackageResolvedDirectory[] = [];

  // -----------------------------------------------------------------------
  // 1. Create directories
  // -----------------------------------------------------------------------
  for (const [index, dir] of (manifest.directories ?? []).entries()) {
    const resolved = applyTemplateToPath(dir.path, ctx);
    const abs = path.isAbsolute(resolved) ? resolved : path.resolve(packagePath, resolved);
    const templateVars = [
      `HOST_DIR_${index + 1}`,
      `${dir.purpose.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_DIR`,
      `HOST_${dir.purpose.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_DIR`
    ].filter((value, position, all) => all.indexOf(value) === position);

    resolvedDirectories.push({
      path: abs,
      purpose: dir.purpose,
      description: dir.description,
      templateVars
    });

    if (!dir.createIfMissing) continue;
    if (dryRun) {
      steps.push({
        kind: 'mkdir',
        description: `Would create directory: ${abs}`,
        status: 'skipped',
        detail: 'dry-run'
      });
    } else {
      steps.push(mkdirStep(abs));
    }
  }

  // -----------------------------------------------------------------------
  // 2. Podman image step (pull or build)
  // -----------------------------------------------------------------------
  if (!skipPodmanSteps) {
    const strategy = manifest.install?.strategy;

    if (strategy === 'prebuilt-image') {
      const image = extractImageName(manifest);
      if (image) {
        steps.push(await podmanPullStep(applyTemplate(image, ctx), dryRun));
      }
    } else if (strategy === 'dockerfile') {
      const tag = deriveImageTag(manifest);
      const dockerfileDir = manifest.artifacts?.dockerfile
        ? path.dirname(path.resolve(packagePath, manifest.artifacts.dockerfile))
        : packagePath;
      steps.push(await podmanBuildStep(applyTemplate(tag, ctx), dockerfileDir, dryRun));
    }
  }

  // -----------------------------------------------------------------------
  // 3. Install lifecycle command from pod manifest (e.g. scripts/install.sh)
  // -----------------------------------------------------------------------
  const installCmd = manifest.pod.install;
  if (installCmd?.command) {
    const resolvedCommand = applyTemplateToCommand(installCmd.command, ctx) ?? installCmd.command;
    const resolvedCwd = installCmd.cwd
      ? applyTemplateToPath(installCmd.cwd, ctx)
      : packagePath;
    const resolvedEnv = applyTemplateToEnv(installCmd.env, ctx);
    steps.push(await installCommandStep(resolvedCommand, resolvedCwd, resolvedEnv, dryRun));
  }

  const ok = steps.every((s) => s.status !== 'error');
  return {
    steps,
    ok,
    templateContext: Object.fromEntries(
      Object.entries(ctx).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    resolvedDirectories
  };
}

// ---------------------------------------------------------------------------
// Helper: describe what install hooks would do (for dry-run summaries)
// ---------------------------------------------------------------------------
export function describeInstallHooks(manifest: PodPackageManifest, packagePath: string): string[] {
  const ctx = buildPackageTemplateContext(manifest, packagePath);
  const lines: string[] = [];

  for (const dir of manifest.directories ?? []) {
    if (!dir.createIfMissing) continue;
    const resolved = applyTemplateToPath(dir.path, ctx);
    lines.push(`mkdir -p ${resolved}`);
  }

  const strategy = manifest.install?.strategy;
  if (strategy === 'prebuilt-image') {
    const image = extractImageName(manifest);
    if (image) lines.push(`podman pull ${image}`);
  } else if (strategy === 'dockerfile') {
    lines.push(`podman build -t ${deriveImageTag(manifest)} ${packagePath}`);
  }

  const installCmd = manifest.pod.install?.command;
  if (installCmd) {
    lines.push(`install: ${applyTemplateToCommand(installCmd, ctx)}`);
  }

  return lines;
}

// Re-export applyTemplate for consumers who want to template arbitrary strings.
export { applyTemplate } from './path-template.js';
