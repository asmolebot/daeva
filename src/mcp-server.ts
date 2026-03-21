/**
 * mcp-server.ts — Thin MCP (Model Context Protocol) server surface over the orchestrator HTTP API.
 *
 * Runs as a stdio transport: reads JSON-RPC 2.0 messages from stdin (newline-delimited),
 * writes responses to stdout. Proxies all tool calls to the orchestrator HTTP API.
 *
 * Tools exposed:
 *   list_pods          — GET /pods
 *   list_aliases       — GET /pods/aliases
 *   get_status         — GET /status
 *   get_scheduler      — GET /status/scheduler
 *   enqueue_job        — POST /jobs
 *   get_job            — GET /jobs/:jobId
 *   create_pod         — POST /pods/create
 *   list_installed     — GET /pods/installed
 *
 * Usage:
 *   node dist/src/mcp-server.js --base-url http://127.0.0.1:8787
 *   # or via env var: ORCHESTRATOR_BASE_URL=http://... node dist/src/mcp-server.js
 */

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const argIdx = process.argv.indexOf('--base-url');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    return process.argv[argIdx + 1].replace(/\/$/, '');
  }
  return (process.env.ORCHESTRATOR_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// MCP protocol constants
// ---------------------------------------------------------------------------

const MCP_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'list_pods',
    description: 'List all registered pods in the orchestrator.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_aliases',
    description: 'List available pod aliases that can be used with create_pod.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_installed',
    description: 'List installed pod packages.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_status',
    description: 'Get a full status snapshot of the orchestrator (pods, jobs, scheduler, packages).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_scheduler',
    description: 'Get scheduler state (queue depth, running jobs, exclusivity groups).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'enqueue_job',
    description: 'Submit a job to the orchestrator. Returns a job record with id and status.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Job type string (e.g. "transcribe-audio", "generate-image").'
        },
        capability: {
          type: 'string',
          enum: ['image-generation', 'speech-to-text', 'ocr', 'vision'],
          description: 'Capability to route the job to.'
        },
        input: {
          type: 'object',
          description: 'Capability-specific input payload.'
        },
        preferredPodId: {
          type: 'string',
          description: 'Optional pod id to prefer for routing.'
        }
      },
      required: ['type', 'input']
    }
  },
  {
    name: 'get_job',
    description: 'Fetch the current state and result of a job by id.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id returned from enqueue_job.' }
      },
      required: ['jobId']
    }
  },
  {
    name: 'create_pod',
    description:
      'Install a pod package from a registry alias or a source descriptor. ' +
      'Use list_aliases to discover valid alias names.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Registry alias (e.g. "whisper", "comfy"). Use list_aliases to discover.'
        },
        source: {
          type: 'object',
          description:
            'Direct source descriptor (alternative to alias). ' +
            'Supported kinds: "local-file", "github-repo", "git-repo".',
          properties: {
            kind: { type: 'string' }
          }
        }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// HTTP proxy helpers
// ---------------------------------------------------------------------------

async function apiGet(baseUrl: string, path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`);
  return res.json();
}

async function apiPost(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function callTool(
  baseUrl: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let data: unknown;

    switch (toolName) {
      case 'list_pods':
        data = await apiGet(baseUrl, '/pods');
        break;

      case 'list_aliases':
        data = await apiGet(baseUrl, '/pods/aliases');
        break;

      case 'list_installed':
        data = await apiGet(baseUrl, '/pods/installed');
        break;

      case 'get_status':
        data = await apiGet(baseUrl, '/status');
        break;

      case 'get_scheduler':
        data = await apiGet(baseUrl, '/status/scheduler');
        break;

      case 'enqueue_job': {
        const result = await apiPost(baseUrl, '/jobs', toolInput);
        data = result.body;
        break;
      }

      case 'get_job': {
        const jobId = String(toolInput.jobId ?? '');
        if (!jobId) throw new Error('jobId is required');
        const [jobData, resultData] = await Promise.all([
          apiGet(baseUrl, `/jobs/${jobId}`),
          apiGet(baseUrl, `/jobs/${jobId}/result`)
        ]);
        data = { job: (jobData as { job?: unknown }).job, result: (resultData as { result?: unknown }).result };
        break;
      }

      case 'create_pod': {
        const result = await apiPost(baseUrl, '/pods/create', toolInput);
        data = result.body;
        break;
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error calling ${toolName}: ${message}` }],
      isError: true
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function handleRequest(baseUrl: string, req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_VERSION,
        serverInfo: { name: 'asmo-pod-orchestrator-mcp', version: '0.1.0' },
        capabilities: { tools: {} }
      }
    };
  }

  if (method === 'notifications/initialized') {
    // No response needed for notifications, but we return null to signal skip
    return { jsonrpc: '2.0', id: null, result: null };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (method === 'tools/call') {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = p?.name ?? '';
    const toolInput = p?.arguments ?? {};
    const toolResult = await callTool(baseUrl, toolName, toolInput);
    return {
      jsonrpc: '2.0',
      id,
      result: toolResult
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runMcpServer(): Promise<void> {
  const baseUrl = getBaseUrl();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      };
      process.stdout.write(JSON.stringify(errResp) + '\n');
      continue;
    }

    // Notifications (no id or id=null with method starting with "notifications/") don't get responses
    if (req.method?.startsWith('notifications/')) {
      continue;
    }

    const response = await handleRequest(baseUrl, req);
    // Skip synthetic null-id responses from notification-like methods
    if (response.id !== null || response.result !== null) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
}
