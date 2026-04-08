/**
 * Proxy Mode — API-aware Queueing Proxy
 *
 * Exposes `/proxy/:podId/*` routes that transparently forward HTTP and
 * WebSocket traffic to a pod's internal baseUrl.  Before forwarding, the
 * handler acquires the GPU exclusivity lock (via PodController), starts
 * the pod if it is stopped, and releases the lock when the proxied
 * request (or WebSocket connection) completes.
 */

import http from 'node:http';
import { URL } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { NotFoundError, SchedulingError } from './errors.js';
import type { PodController } from './pod-controller.js';
import type { PodRegistry } from './registry.js';
import type { HttpServiceRuntime, PodManifest } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sessionSeq = 0;
const nextSessionId = (): string => `proxy-${++sessionSeq}`;

interface ResolvedPod {
  manifest: PodManifest;
  runtime: HttpServiceRuntime;
}

function resolveHttpPod(registry: PodRegistry, podId: string): ResolvedPod {
  const manifest = registry.get(podId);
  if (!manifest) {
    throw new NotFoundError(`Unknown pod: ${podId}`);
  }
  if (manifest.runtime.kind !== 'http-service') {
    throw new SchedulingError(`Proxy mode requires an http-service runtime (pod: ${podId})`);
  }
  return { manifest, runtime: manifest.runtime };
}

function buildUpstreamUrl(baseUrl: string, path: string, queryString: string): URL {
  const clean = `${baseUrl.replace(/\/$/, '')}/${path}${queryString}`;
  return new URL(clean);
}

/** Headers that must not be forwarded hop-to-hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
]);

function forwardHeaders(
  original: Record<string, string | string[] | undefined>,
  upstreamHost: string
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(original)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  out['host'] = upstreamHost;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ProxyHandlerDeps {
  registry: PodRegistry;
  podController: PodController;
}

/**
 * Register the transparent proxy routes on the Fastify instance.
 *
 * - `ALL /proxy/:podId/*`  — HTTP proxy (any method)
 * - `ALL /proxy/:podId`    — HTTP proxy (root path of the pod service)
 * - WebSocket `upgrade` on `/proxy/:podId/…` paths
 */
export function registerProxyHandler(app: FastifyInstance, deps: ProxyHandlerDeps): void {
  const { registry, podController } = deps;

  // Encapsulate so the permissive content-type parser only applies to proxy
  // routes and does not interfere with the JSON parsing on other endpoints.
  void app.register(async function proxyPlugin(scope) {
    // Accept any content-type — buffer the body so we can forward it.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: null, body: Buffer) => void) => {
        done(null, body);
      }
    );

    const handleProxy = async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { podId: string; '*'?: string };
      const podId = params.podId;
      const wildcardPath = params['*'] ?? '';

      const { manifest, runtime } = resolveHttpPod(registry, podId);

      const sessionId = nextSessionId();

      // Acquire GPU exclusivity and ensure the pod is running.
      await podController.ensureExclusive(manifest, registry.list());
      podController.markJobStarted(manifest.id, sessionId);

      // Build the upstream URL, preserving query string.
      const rawUrl = request.url;
      const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
      const upstream = buildUpstreamUrl(runtime.baseUrl, wildcardPath, qs);

      // Tell Fastify we will handle the raw response ourselves.
      reply.hijack();

      const proxyReq = http.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          path: upstream.pathname + upstream.search,
          method: request.method,
          headers: forwardHeaders(
            request.headers as Record<string, string | string[] | undefined>,
            upstream.host
          ),
        },
        (proxyRes) => {
          reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(reply.raw);
          proxyRes.on('end', () => {
            podController.markJobFinished(manifest.id, sessionId);
          });
        }
      );

      proxyReq.on('error', (err) => {
        podController.markJobFinished(manifest.id, sessionId);
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { 'content-type': 'application/json' });
        }
        reply.raw.end(
          JSON.stringify({
            error: {
              code: 'PROXY_ERROR',
              type: 'proxy',
              message: `Upstream request failed: ${err.message}`,
              retriable: true,
            },
          })
        );
      });

      // Forward the buffered request body (may be empty for GET/HEAD/etc.).
      const body = request.body as Buffer | null | undefined;
      if (body && body.length > 0) {
        proxyReq.end(body);
      } else {
        proxyReq.end();
      }
    };

    scope.all('/proxy/:podId', handleProxy);
    scope.all('/proxy/:podId/*', handleProxy);
  });

  // -----------------------------------------------------------------
  // WebSocket upgrade handler — hooks the raw Node HTTP server so
  // upgrade requests on /proxy/:podId/… are forwarded transparently.
  // -----------------------------------------------------------------

  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const match = url.match(/^\/proxy\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!match) {
      // Not a proxy-prefixed path — ignore (other upgrade handlers or
      // Fastify itself may handle it).
      return;
    }

    const podId = match[1];
    const restPath = match[2] ?? '/';
    const qs = match[3] ?? '';

    let manifest: PodManifest;
    let runtime: HttpServiceRuntime;
    try {
      const resolved = resolveHttpPod(registry, podId);
      manifest = resolved.manifest;
      runtime = resolved.runtime;
    } catch {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = nextSessionId();

    podController
      .ensureExclusive(manifest, registry.list())
      .then(() => {
        podController.markJobStarted(manifest.id, sessionId);

        const upstream = buildUpstreamUrl(runtime.baseUrl, restPath.replace(/^\//, ''), qs);

        const wsHeaders = forwardHeaders(
          req.headers as Record<string, string | string[] | undefined>,
          upstream.host
        );
        // Restore hop-by-hop headers required for the WebSocket handshake.
        wsHeaders['connection'] = 'Upgrade';
        wsHeaders['upgrade'] = req.headers['upgrade'] ?? 'websocket';

        const proxyReq = http.request({
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          path: upstream.pathname + upstream.search,
          method: 'GET',
          headers: wsHeaders,
        });

        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          // Relay the upstream 101 Switching Protocols response.
          let response = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
          for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
            response += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
          }
          response += '\r\n';
          socket.write(response);
          if (proxyHead.length > 0) {
            socket.write(proxyHead);
          }

          // Bidirectional pipe.
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);

          // Release the lock and tear down both sockets when either side closes.
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            podController.markJobFinished(manifest.id, sessionId);
            socket.destroy();
            proxySocket.destroy();
          };

          socket.on('close', release);
          socket.on('error', release);
          proxySocket.on('close', release);
          proxySocket.on('error', release);
        });

        proxyReq.on('error', (err) => {
          podController.markJobFinished(manifest.id, sessionId);
          socket.write(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nUpstream WebSocket error: ${err.message}`
          );
          socket.destroy();
        });

        proxyReq.end(head);
      })
      .catch(() => {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
      });
  });
}
