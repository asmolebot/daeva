import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server.js';
import { JobManager } from '../src/job-manager.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import { SchedulerRouter } from '../src/router.js';
import { testManifests } from './helpers.js';

/* ---------- Auth-enabled app ---------- */

const TEST_KEY = 'test-key-alpha';
const TEST_KEY_2 = 'test-key-beta';

const registry = new PodRegistry(testManifests());
const podController = new PodController(registry.list());
const router = new SchedulerRouter(registry, podController);
const jobManager = new JobManager(registry, podController, router);

const { app: authApp } = await buildApp({
  registry,
  podController,
  router,
  jobManager,
  auth: { apiKeys: `${TEST_KEY},${TEST_KEY_2}` }
});

afterAll(async () => {
  await authApp.close();
});

describe('Auth — API key authentication', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await authApp.inject({ method: 'GET', url: '/pods', remoteAddress: '10.0.0.1' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for invalid API key', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '10.0.0.1',
      headers: { authorization: 'Bearer wrong-key' }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid API key');
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '10.0.0.1',
      headers: { authorization: `Basic ${TEST_KEY}` }
    });
    expect(res.statusCode).toBe(401);
  });

  it('passes with valid API key', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '10.0.0.1',
      headers: { authorization: `Bearer ${TEST_KEY}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts any of the configured keys', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '10.0.0.1',
      headers: { authorization: `Bearer ${TEST_KEY_2}` }
    });
    expect(res.statusCode).toBe(200);
  });

  it('bypasses auth for localhost (127.0.0.1) by default', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(200);
  });

  it('bypasses auth for localhost (::1) by default', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '::1'
    });
    expect(res.statusCode).toBe(200);
  });
});

/* ---------- Auth with requireLocalhost ---------- */

describe('Auth — requireLocalhost mode', () => {
  let strictApp: Awaited<ReturnType<typeof buildApp>>['app'];

  it('requires auth even for localhost when requireLocalhost=true', async () => {
    const r2 = new PodRegistry(testManifests());
    const pc2 = new PodController(r2.list());
    const ro2 = new SchedulerRouter(r2, pc2);
    const jm2 = new JobManager(r2, pc2, ro2);
    const built = await buildApp({
      registry: r2,
      podController: pc2,
      router: ro2,
      jobManager: jm2,
      auth: { apiKeys: TEST_KEY, requireLocalhost: true }
    });
    strictApp = built.app;

    const res = await strictApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(401);

    // But valid key still works
    const res2 = await strictApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${TEST_KEY}` }
    });
    expect(res2.statusCode).toBe(200);

    await strictApp.close();
  });
});

/* ---------- No auth (default) ---------- */

describe('Auth — disabled when no keys configured', () => {
  it('allows all requests when auth is not configured', async () => {
    const r3 = new PodRegistry(testManifests());
    const pc3 = new PodController(r3.list());
    const ro3 = new SchedulerRouter(r3, pc3);
    const jm3 = new JobManager(r3, pc3, ro3);
    const { app: noAuthApp } = await buildApp({
      registry: r3,
      podController: pc3,
      router: ro3,
      jobManager: jm3
    });

    const res = await noAuthApp.inject({
      method: 'GET',
      url: '/pods',
      remoteAddress: '10.0.0.1'
    });
    expect(res.statusCode).toBe(200);

    await noAuthApp.close();
  });
});

/* ---------- Rate limiting ---------- */

describe('Rate limiting', () => {
  it('returns 429 after exceeding rate limit', async () => {
    const r4 = new PodRegistry(testManifests());
    const pc4 = new PodController(r4.list());
    const ro4 = new SchedulerRouter(r4, pc4);
    const jm4 = new JobManager(r4, pc4, ro4);
    const { app: rlApp } = await buildApp({
      registry: r4,
      podController: pc4,
      router: ro4,
      jobManager: jm4,
      rateLimit: { max: 3, windowMs: 60_000 }
    });

    // First 3 requests should pass
    for (let i = 0; i < 3; i++) {
      const res = await rlApp.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }

    // 4th request should be rate limited
    const res = await rlApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(429);

    await rlApp.close();
  });
});
