import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/server.js';
import { PodController } from '../src/pod-controller.js';
import { PodRegistry } from '../src/registry.js';
import type { PodManifest } from '../src/types.js';

// ---------------------------------------------------------------------------
// Tiny upstream HTTP server that echoes requests back as JSON.
// Also supports WebSocket upgrades (bare 101 + echo loop).
// ---------------------------------------------------------------------------

let upstream: http.Server;
let upstreamPort: number;

function createUpstream(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body || null,
          })
        );
      });
    });

    // Minimal WebSocket upgrade handler (raw, no framing — enough for tests).
    server.on('upgrade', (req, socket, head) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n'
      );
      // Echo anything received back to the client, then close.
      socket.on('data', (data) => {
        socket.write(data);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// ---------------------------------------------------------------------------
// Build a test manifest whose runtime.baseUrl points at the upstream server.
// ---------------------------------------------------------------------------

function proxyManifest(port: number): PodManifest {
  return {
    id: 'test-proxy-pod',
    nickname: 'Test Proxy Pod',
    description: 'A pod used for proxy handler tests',
    capabilities: ['image-generation'],
    source: {},
    runtime: {
      kind: 'http-service',
      baseUrl: `http://127.0.0.1:${port}`,
      submitPath: '/submit',
    },
    exclusivityGroup: 'gpu-0',
    startup: { simulatedDelayMs: 0 },
    shutdown: { simulatedDelayMs: 0 },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Proxy Handler', () => {
  let registry: PodRegistry;
  let podController: PodController;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];

  beforeAll(async () => {
    const { server, port } = await createUpstream();
    upstream = server;
    upstreamPort = port;

    const manifest = proxyManifest(upstreamPort);
    registry = new PodRegistry([manifest]);
    podController = new PodController(registry.list());
    const built = await buildApp({ registry, podController });
    app = built.app;
  });

  afterAll(async () => {
    // Force-close any lingering connections from proxy test traffic.
    upstream.closeAllConnections();
    upstream.close();
    await app.close();
  }, 15_000);

  // -- HTTP proxy tests -----------------------------------------------------

  it('proxies GET requests to the upstream pod', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/test-proxy-pod/api/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toBe('GET');
    expect(body.url).toBe('/api/status');
  });

  it('proxies POST requests with a JSON body', async () => {
    const payload = JSON.stringify({ prompt: 'hello' });
    const res = await app.inject({
      method: 'POST',
      url: '/proxy/test-proxy-pod/api/prompt',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toBe('POST');
    expect(body.url).toBe('/api/prompt');
    expect(JSON.parse(body.body)).toEqual({ prompt: 'hello' });
  });

  it('preserves query string parameters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/test-proxy-pod/api/search?q=hello&limit=10',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBe('/api/search?q=hello&limit=10');
  });

  it('proxies the bare /proxy/:podId path (no trailing subpath)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/test-proxy-pod',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Root path is forwarded as /
    expect(body.url).toBe('/');
  });

  it('returns 404 for an unknown podId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/proxy/nonexistent/api/status',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('tracks active proxy sessions via the pod controller', async () => {
    // Before any proxy request, no active jobs should be tracked.
    expect(podController.getActiveJobCount('test-proxy-pod')).toBe(0);

    // After the request completes the session should be released.
    await app.inject({ method: 'GET', url: '/proxy/test-proxy-pod/health' });
    expect(podController.getActiveJobCount('test-proxy-pod')).toBe(0);
  });

  it('marks the pod as running after a proxy request', async () => {
    await app.inject({ method: 'GET', url: '/proxy/test-proxy-pod/health' });
    expect(podController.getStatus('test-proxy-pod')).toBe('running');
  });

  it('rejects proxy for non-http-service pods', async () => {
    // Register an rpod-runtime pod to test the guard.
    registry.register({
      id: 'rpod-only',
      nickname: 'Remote Pod',
      description: 'Not proxiable',
      capabilities: ['speech-to-text'],
      source: {},
      runtime: { kind: 'rpod', host: 'remote-host' },
    });
    podController.syncManifest(registry.get('rpod-only')!);

    const res = await app.inject({
      method: 'GET',
      url: '/proxy/rpod-only/health',
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('SCHEDULING_ERROR');
  });

  // -- WebSocket upgrade tests -----------------------------------------------

  it('upgrades WebSocket connections through the proxy', { timeout: 15_000 }, async () => {
    // Start the Fastify server on a real port so we can make raw HTTP requests.
    // We use a separate Fastify app to avoid interfering with inject()-based tests.
    const wsManifest = proxyManifest(upstreamPort);
    const wsRegistry = new PodRegistry([wsManifest]);
    const wsController = new PodController(wsRegistry.list());
    const { app: wsApp } = await buildApp({ registry: wsRegistry, podController: wsController });

    const address = await wsApp.listen({ port: 0, host: '127.0.0.1' });
    const appPort = new URL(address).port;

    try {
      const result = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Manual timeout: no upgrade/response within 10s')), 10_000);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: Number(appPort),
            path: '/proxy/test-proxy-pod/ws',
            method: 'GET',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
            },
          },
          (res) => {
            clearTimeout(timer);
            let body = '';
            res.on('data', (d: Buffer) => body += d);
            res.on('end', () => {
              reject(new Error(`Expected upgrade but got HTTP ${res.statusCode}: ${body}`));
            });
          }
        );

        req.on('upgrade', (res, socket) => {
          clearTimeout(timer);
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
          socket.destroy();
        });

        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.end();
      });

      expect(result.statusCode).toBe(101);
      expect(result.headers['upgrade']?.toLowerCase()).toBe('websocket');
    } finally {
      // Force-close to avoid lingering WebSocket tunnels blocking shutdown.
      wsApp.server.closeAllConnections();
      void wsApp.close();
    }
  });
});
