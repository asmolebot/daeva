#!/usr/bin/env node
import { buildApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = buildApp();

const start = async () => {
  try {
    await app.listen({ port, host });
    console.log(`asmo-pod-orchestrator listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
