/**
 * path-template.ts
 *
 * Simple variable substitution for host paths and lifecycle commands.
 *
 * Variables are referenced as either `${VAR}` or `{{VAR}}` in strings.
 *
 * Standard built-in variables (populated automatically when not overridden):
 *   HOME        - current user's home directory
 *   USER        - current username
 *   PACKAGE_DIR - absolute path to the materialized package directory
 *   DATA_DIR    - absolute path to a conventional data sub-directory (<PACKAGE_DIR>/data)
 *   POD_ID      - pod id from the manifest
 *
 * Callers may supply additional context keys to expand custom variables.
 * Unknown variables are left as-is (not replaced) so unexpected typos are visible.
 */

import os from 'node:os';
import path from 'node:path';

import type { PodPackageManifest } from './types.js';

export interface TemplateContext {
  /** User's home directory. Defaults to os.homedir(). */
  HOME?: string;
  /** Current username. Defaults to os.userInfo().username. */
  USER?: string;
  /** Absolute path to the materialized package directory. */
  PACKAGE_DIR?: string;
  /** Absolute path to the data sub-directory inside the package. Defaults to <PACKAGE_DIR>/data if PACKAGE_DIR is set. */
  DATA_DIR?: string;
  /** Pod identifier from the manifest. */
  POD_ID?: string;
  /** Any additional custom variables. */
  [key: string]: string | undefined;
}

/** Pattern matching ${VAR} and {{VAR}} references. */
const TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Build a full template context by merging built-in defaults with any caller-supplied values.
 * Caller-supplied values always win.
 */
export function buildContext(overrides: TemplateContext = {}): TemplateContext {
  const home = overrides.HOME ?? os.homedir();
  const user = overrides.USER ?? (() => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER ?? 'user';
    }
  })();

  const packageDir = overrides.PACKAGE_DIR;
  const dataDir = overrides.DATA_DIR ?? (packageDir ? path.join(packageDir, 'data') : undefined);

  return {
    HOME: home,
    USER: user,
    PACKAGE_DIR: packageDir,
    DATA_DIR: dataDir,
    POD_ID: overrides.POD_ID,
    ...overrides
  };
}

/**
 * Apply template variable substitution to a single string.
 * Unrecognised variables (no matching key in context) are left unchanged.
 */
export function applyTemplate(text: string, context: TemplateContext): string {
  return text.replace(TEMPLATE_PATTERN, (match, dollarKey: string | undefined, braceKey: string | undefined) => {
    const key = dollarKey ?? braceKey ?? '';
    const value = context[key];
    return typeof value === 'string' ? value : match;
  });
}

/**
 * Apply template substitution to a command string, returning undefined if the input is undefined.
 */
export function applyTemplateToCommand(command: string | undefined, context: TemplateContext): string | undefined {
  if (command === undefined) return undefined;
  return applyTemplate(command, context);
}

/**
 * Apply template substitution to each value in a Record<string, string>.
 * Keys are not substituted — only values.
 */
export function applyTemplateToEnv(
  env: Record<string, string> | undefined,
  context: TemplateContext
): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = applyTemplate(v, context);
  }
  return result;
}

/**
 * Apply template substitution to a host directory path.
 *
 * If the resolved path is relative it is joined against the PACKAGE_DIR from
 * context (when available) so that relative package-manifest paths like
 * `data/models` expand correctly to absolute host paths.
 */
export function applyTemplateToPath(hostPath: string, context: TemplateContext): string {
  const substituted = applyTemplate(hostPath, context);
  if (path.isAbsolute(substituted)) {
    return substituted;
  }
  const packageDir = context.PACKAGE_DIR;
  return packageDir ? path.resolve(packageDir, substituted) : substituted;
}

const directoryPurposeVar = (purpose: string) => `${purpose.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_DIR`;

export function buildPackageTemplateContext(
  manifest: PodPackageManifest,
  packageDir: string,
  overrides: TemplateContext = {}
): TemplateContext {
  const ctx = buildContext({
    PACKAGE_DIR: packageDir,
    POD_ID: manifest.pod.id,
    ...overrides
  });

  (manifest.directories ?? []).forEach((directory, index) => {
    const resolvedPath = applyTemplateToPath(directory.path, ctx);
    const vars = [
      `HOST_DIR_${index + 1}`,
      directoryPurposeVar(directory.purpose),
      `HOST_${directoryPurposeVar(directory.purpose)}`
    ];

    ctx[vars[0]] = resolvedPath;
    for (const variable of vars.slice(1)) {
      if (!ctx[variable]) {
        ctx[variable] = resolvedPath;
      }
    }
  });

  return ctx;
}
