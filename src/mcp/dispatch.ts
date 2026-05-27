// scripts/pm/mcp/dispatch.ts — pure MCP JSON-RPC dispatcher.
// Stdin/stdout glue lives in server.ts; this module is a pure function
// from RPC request → RPC response so it's trivially testable.
//
// Protocol: https://spec.modelcontextprotocol.io/specification/2024-11-05/
// We implement only the surface Claude Code actually calls:
//   initialize          → server capabilities + name + version
//   tools/list          → enumerate the loom__* tools
//   tools/call          → invoke a single tool with arguments
//
// All other methods return a -32601 (method-not-found) JSON-RPC error.

import type Database from 'better-sqlite3';

import { TOOLS, callTool } from './tools';

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'loom';
const SERVER_VERSION = '0.1.0';

export async function dispatch(req: RpcRequest, db: Database.Database): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  // Notifications (no id) are fire-and-forget; we honor `notifications/initialized`
  // by returning null (no response written).
  if (req.id === undefined || req.id === null) {
    return null;
  }

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      };

    case 'tools/call': {
      const name = (req.params?.name as string) ?? '';
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const content = await callTool(name, args, db);
        return { jsonrpc: '2.0', id, result: { content, isError: false } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}
