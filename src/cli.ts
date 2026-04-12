#!/usr/bin/env node
import { buildApp } from './server.js';

const parseInteger = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const hasFlag = (name: string): boolean => process.argv.includes(name);

const port = parseInteger(readFlag('--port')) ?? Number.parseInt(process.env.PORT ?? '8787', 10);
const host = readFlag('--host') ?? process.env.HOST ?? '127.0.0.1';
const dataDir = readFlag('--data-dir') ?? process.env.DATA_DIR;
const hotSwapMode = hasFlag('--hot-swap-mode') || process.env.DAEVA_HOT_SWAP_MODE === 'true';
const autoFitPods = hasFlag('--auto-fit-pods') || process.env.DAEVA_AUTO_FIT_PODS === 'true';
const gpuCapacityMB = parseInteger(readFlag('--gpu-capacity-mb')) ?? parseInteger(process.env.DAEVA_GPU_CAPACITY_MB);

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
    uploadMaxBytes: process.env.ASMO_UPLOAD_MAX_BYTES ? Number.parseInt(process.env.ASMO_UPLOAD_MAX_BYTES, 10) : undefined,
    managedPackagesRoot: dataDir ? `${dataDir}/pod-packages` : undefined,
    schedulerConfig: {
      hotSwapMode,
      autoFitPods,
      gpuCapacityMB
    }
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
