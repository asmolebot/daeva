import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyTemplate,
  applyTemplateToCommand,
  applyTemplateToEnv,
  applyTemplateToPath,
  buildContext,
  buildPackageTemplateContext
} from '../src/path-template.js';

describe('buildContext', () => {
  it('fills in HOME and USER by default', () => {
    const ctx = buildContext();
    expect(ctx.HOME).toBe(os.homedir());
    expect(typeof ctx.USER).toBe('string');
    expect(ctx.USER!.length).toBeGreaterThan(0);
  });

  it('derives DATA_DIR from PACKAGE_DIR when not supplied', () => {
    const ctx = buildContext({ PACKAGE_DIR: '/opt/my-package' });
    expect(ctx.DATA_DIR).toBe('/opt/my-package/data');
  });

  it('allows caller overrides to win over defaults', () => {
    const ctx = buildContext({ HOME: '/custom/home', PACKAGE_DIR: '/pkg', DATA_DIR: '/custom/data' });
    expect(ctx.HOME).toBe('/custom/home');
    expect(ctx.DATA_DIR).toBe('/custom/data');
  });

  it('passes through arbitrary extra keys', () => {
    const ctx = buildContext({ MY_CUSTOM_VAR: 'hello' });
    expect(ctx.MY_CUSTOM_VAR).toBe('hello');
  });

  it('derives stable directory aliases for package manifests', () => {
    const ctx = buildPackageTemplateContext({
      schemaVersion: '1',
      packageType: 'pod-package',
      name: 'pkg',
      version: '1.0.0',
      pod: {
        id: 'demo',
        nickname: 'Demo',
        description: 'desc',
        capabilities: ['speech-to-text'],
        source: {},
        runtime: {
          kind: 'http-service',
          baseUrl: 'http://127.0.0.1:9999',
          submitPath: '/run'
        }
      },
      directories: [
        { path: '${HOME}/models', purpose: 'models' },
        { path: 'data/input', purpose: 'input' }
      ]
    }, '/pkg', { HOME: '/tmp/home' });

    expect(ctx.MODELS_DIR).toBe('/tmp/home/models');
    expect(ctx.HOST_MODELS_DIR).toBe('/tmp/home/models');
    expect(ctx.INPUT_DIR).toBe('/pkg/data/input');
    expect(ctx.HOST_DIR_2).toBe('/pkg/data/input');
  });
});

describe('applyTemplate', () => {
  it('replaces ${VAR} style references', () => {
    const result = applyTemplate('Path is ${HOME}/stuff', { HOME: '/users/test' });
    expect(result).toBe('Path is /users/test/stuff');
  });

  it('replaces {{VAR}} style references', () => {
    const result = applyTemplate('Path is {{HOME}}/stuff', { HOME: '/users/test' });
    expect(result).toBe('Path is /users/test/stuff');
  });

  it('leaves unknown variables unchanged', () => {
    const result = applyTemplate('Hello ${UNKNOWN}', {});
    expect(result).toBe('Hello ${UNKNOWN}');
  });

  it('replaces multiple occurrences', () => {
    const result = applyTemplate('${A} and ${A} and ${B}', { A: 'foo', B: 'bar' });
    expect(result).toBe('foo and foo and bar');
  });

  it('handles mixed styles in the same string', () => {
    const result = applyTemplate('${A} and {{B}}', { A: '1', B: '2' });
    expect(result).toBe('1 and 2');
  });

  it('replaces empty string values', () => {
    const result = applyTemplate('prefix-${X}-suffix', { X: '' });
    expect(result).toBe('prefix--suffix');
  });
});

describe('applyTemplateToCommand', () => {
  it('returns undefined for undefined input', () => {
    expect(applyTemplateToCommand(undefined, {})).toBeUndefined();
  });

  it('substitutes variables in a command string', () => {
    const result = applyTemplateToCommand('${PACKAGE_DIR}/scripts/start.sh', {
      PACKAGE_DIR: '/opt/my-pod'
    });
    expect(result).toBe('/opt/my-pod/scripts/start.sh');
  });
});

describe('applyTemplateToEnv', () => {
  it('returns undefined for undefined input', () => {
    expect(applyTemplateToEnv(undefined, {})).toBeUndefined();
  });

  it('substitutes variables in env values but not in keys', () => {
    const result = applyTemplateToEnv(
      { MODELS: '${DATA_DIR}/models', OTHER: 'static' },
      { DATA_DIR: '/pkg/data' }
    );
    expect(result).toEqual({ MODELS: '/pkg/data/models', OTHER: 'static' });
  });
});

describe('applyTemplateToPath', () => {
  it('returns absolute paths as-is after substitution', () => {
    const result = applyTemplateToPath('/absolute/${FOO}', { FOO: 'bar' });
    expect(result).toBe('/absolute/bar');
  });

  it('resolves relative paths against PACKAGE_DIR when provided', () => {
    const result = applyTemplateToPath('data/models', { PACKAGE_DIR: '/opt/my-pod' });
    expect(result).toBe(path.resolve('/opt/my-pod', 'data/models'));
  });

  it('leaves relative paths relative when no PACKAGE_DIR is provided', () => {
    const result = applyTemplateToPath('data/models', {});
    expect(result).toBe('data/models');
  });

  it('substitutes variables and resolves against PACKAGE_DIR', () => {
    const result = applyTemplateToPath('${HOME}/ai/whisper/models', {
      HOME: '/home/testuser',
      PACKAGE_DIR: '/opt/pkg'
    });
    // The substituted path is absolute so PACKAGE_DIR doesn't apply
    expect(result).toBe('/home/testuser/ai/whisper/models');
  });
});
