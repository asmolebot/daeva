#!/usr/bin/env node
/**
 * MCP server entry point.
 * Run via: node dist/src/mcp-cli.js [--base-url http://127.0.0.1:8787]
 */
import { runMcpServer } from './mcp-server.js';

void runMcpServer().catch((err) => {
  process.stderr.write(`MCP server error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
