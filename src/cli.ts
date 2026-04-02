#!/usr/bin/env node
import { buildApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '127.0.0.1';

const start = async () => {
  const { app } = await buildApp({
    auth: {
      apiKeys: process.env.ASMO_API_KEYS,
      requireLocalhost: process.env.ASMO_AUTH_REQUIRE_LOCALHOST === 'true'
    },
    rateLimit: {
      max: process.env.ASMO_RATE_LIMIT_MAX ? Number.parseInt(process.env.ASMO_RATE_LIMIT_MAX, 10) : undefined,
      windowMs: process.env.ASMO_RATE_LIMIT_WINDOW_MS ? Number.parseInt(process.env.ASMO_RATE_LIMIT_WINDOW_MS, 10) : undefined
    },
    uploadMaxBytes: process.env.ASMO_UPLOAD_MAX_BYTES ? Number.parseInt(process.env.ASMO_UPLOAD_MAX_BYTES, 10) : undefined
  });

  try {
    await app.listen({ port, host });
    console.log(`daeva listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
