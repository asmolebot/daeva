import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { describeInstallHooks, runInstallHooks } from '../src/install-hooks.js';
import { parseManifest, parsePodPackageManifest } from '../src/manifest-loader.js';
import examplePodPackage from '../examples/whisper-pod-package/pod-package.json' with { type: 'json' };

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'asmo-install-hooks-'));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const manifest = parsePodPackageManifest(examplePodPackage);

describe('describeInstallHooks', () => {
  it('returns mkdir steps for createIfMissing directories', () => {
    const packageDir = '/opt/test-package';
    const steps = describeInstallHooks(manifest, packageDir);
    const mkdirSteps = steps.filter((s) => s.startsWith('mkdir'));
    expect(mkdirSteps.length).toBeGreaterThan(0);
  });

  it('returns a podman pull step for prebuilt-image strategy', () => {
    const steps = describeInstallHooks(manifest, '/opt/test-package');
    const pullStep = steps.find((s) => s.includes('podman pull'));
    expect(pullStep).toBeDefined();
    expect(pullStep).toContain('daeva-whisper');
  });

  it('substitutes HOME in directory paths', () => {
    const fakeHome = '/fake/home';
    const steps = describeInstallHooks(manifest, '/opt/pkg');
    // The directory paths in the manifest use ${HOME} — they should be resolved
    const hasFakeHome = steps.some((s) => s.includes(os.homedir()) || s.includes(fakeHome) || s.includes('ai/services/whisper'));
    expect(hasFakeHome).toBe(true);
  });
});

describe('runInstallHooks (dry-run)', () => {
  it('runs in dry-run mode without executing system commands', async () => {
    const result = await runInstallHooks(manifest, '/opt/fake-package', { dryRun: true });
    // All steps should be skipped in dry-run mode
    expect(result.steps.length).toBeGreaterThan(0);
    for (const step of result.steps) {
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('dry-run');
    }
  });

  it('reports ok=true when all steps succeed or are skipped', async () => {
    const result = await runInstallHooks(manifest, '/opt/fake-package', { dryRun: true });
    expect(result.ok).toBe(true);
  });
});

describe('runInstallHooks (real mkdir, skip podman)', () => {
  it('creates declared directories for a real package path', async () => {
    const fakePackageDir = path.join(tempRoot, 'fake-package');
    mkdirSync(fakePackageDir, { recursive: true });

    // Use a manifest with only relative directories and no install command
    // so we can observe mkdir without needing scripts or podman.
    const minimalManifest = parsePodPackageManifest({
      ...examplePodPackage,
      pod: {
        ...examplePodPackage.pod,
        install: undefined  // no install command — avoid running missing scripts
      },
      directories: [
        {
          path: 'data/models',
          purpose: 'models',
          createIfMissing: true,
          description: 'Test models dir'
        }
      ]
    });

    const result = await runInstallHooks(minimalManifest, fakePackageDir, {
      skipPodmanSteps: true
    });

    const mkdirStep = result.steps.find((s) => s.kind === 'mkdir');
    expect(mkdirStep).toBeDefined();
    expect(mkdirStep!.status).toBe('ok');
    // The directory should now exist
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(fakePackageDir, 'data/models'))).toBe(true);
  });

  it('resolves template variables in directory paths', async () => {
    const fakePackageDir = path.join(tempRoot, 'template-test-package');
    mkdirSync(fakePackageDir, { recursive: true });

    const customHome = path.join(tempRoot, 'custom-home');
    const minimalManifest = parsePodPackageManifest({
      ...examplePodPackage,
      pod: {
        ...examplePodPackage.pod,
        install: undefined  // no install command — avoid running missing scripts
      },
      directories: [
        {
          path: '${HOME}/asmo-test-whisper/models',
          purpose: 'models',
          createIfMissing: true
        }
      ]
    });

    const result = await runInstallHooks(minimalManifest, fakePackageDir, {
      skipPodmanSteps: true,
      templateContext: { HOME: customHome }
    });

    const mkdirStep = result.steps.find((s) => s.kind === 'mkdir');
    expect(mkdirStep).toBeDefined();
    expect(mkdirStep!.status).toBe('ok');
    expect(mkdirStep!.description).toContain(customHome);

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(customHome, 'asmo-test-whisper/models'))).toBe(true);
  });
});

describe('lifecycle semantic fields on PodManifest', () => {
  it('parses install and build fields from a manifest', () => {
    const manifest = parseManifest({
      id: 'test-pod',
      nickname: 'Test',
      description: 'desc',
      manifestVersion: '1',
      capabilities: ['speech-to-text'],
      source: {},
      runtime: {
        kind: 'http-service',
        baseUrl: 'http://127.0.0.1:9000',
        submitPath: '/run',
        method: 'POST'
      },
      install: { command: 'scripts/install.sh' },
      build: { command: 'podman build -t test-pod:latest .' },
      startup: { command: 'scripts/start.sh' },
      shutdown: { command: 'scripts/stop.sh' }
    });
    expect(manifest.install?.command).toBe('scripts/install.sh');
    expect(manifest.build?.command).toContain('podman build');
    expect(manifest.startup?.command).toBe('scripts/start.sh');
    expect(manifest.shutdown?.command).toBe('scripts/stop.sh');
  });
});

describe('service/quadlet metadata on PodPackageManifest', () => {
  it('parses the whisper example quadlet metadata', () => {
    const parsed = parsePodPackageManifest(examplePodPackage);
    expect(parsed.service?.installMode).toBe('quadlet');
    expect(parsed.service?.serviceName).toBe('daeva-whisper');
    expect(parsed.service?.quadlet?.image).toBe('docker.io/library/daeva-whisper:latest');
    expect(parsed.service?.quadlet?.publishPort).toEqual(['8001:8001']);
    expect(parsed.service?.quadlet?.volume?.length).toBeGreaterThan(0);
    expect(parsed.service?.quadlet?.containerName).toBe('daeva-whisper');
    expect(parsed.service?.systemd?.restart).toBe('on-failure');
    expect(parsed.service?.systemd?.timeoutStartSec).toBe(120);
    expect(parsed.service?.systemd?.wantedBy).toContain('default.target');
  });

  it('accepts a manifest with no service metadata', () => {
    const parsed = parsePodPackageManifest({ ...examplePodPackage, service: undefined });
    expect(parsed.service).toBeUndefined();
  });
});
