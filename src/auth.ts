import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface AuthPluginOptions {
  /** Comma-separated API keys, or undefined/empty to disable auth */
  apiKeys?: string;
  /** When true, localhost requests also require auth (default: false) */
  requireLocalhost?: boolean;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalhost(request: FastifyRequest): boolean {
  return LOCALHOST_ADDRS.has(request.ip);
}

function parseApiKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map((k) => k.trim()).filter(Boolean)
  );
}

function _authPlugin(app: FastifyInstance, opts: AuthPluginOptions, done: () => void) {
  const keys = parseApiKeys(opts.apiKeys);
  const authEnabled = keys.size > 0;
  const bypassLocalhost = !opts.requireLocalhost;

  if (!authEnabled) {
    done();
    return;
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (bypassLocalhost && isLocalhost(request)) {
      return;
    }

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          type: 'auth',
          message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <key>',
          retriable: false
        }
      });
      return;
    }

    const token = header.slice(7);
    if (!keys.has(token)) {
      reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          type: 'auth',
          message: 'Invalid API key',
          retriable: false
        }
      });
      return;
    }
  });

  done();
}

export const authPlugin = fp(_authPlugin, { name: 'asmo-auth' });
