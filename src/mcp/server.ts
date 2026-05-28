// scripts/pm/mcp/server.ts — MCP stdio entrypoint.
//
// Spawned by Claude Code via .mcp.json. Reads line-delimited JSON-RPC
// requests on stdin, writes responses to stdout. Logs (stderr) are NOT
// part of the protocol — keep them sparse so an MCP client doesn't choke.
//
// Run manually for smoke-test:
//   $ npm run pm:mcp
//   {"jsonrpc":"2.0","id":1,"method":"initialize"}
//   {"jsonrpc":"2.0","id":1,"result":{...}}

import * as readline from 'node:readline';

import { getDb } from '../db';
import { dispatch, type RpcRequest } from './dispatch';

export async function startMcpServer(): Promise<void> {
  const db = getDb();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${message}` } }) + '\n',
      );
      return;
    }

    const response = await dispatch(req, db);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });

  rl.on('close', () => {
    db.close();
    process.exit(0);
  });

  // Ready banner to stderr (stdout is reserved for JSON-RPC frames).
  process.stderr.write(`[swrm-mcp] ready (db=${process.env.SWRM_DB_PATH ?? process.env.PM_DB_PATH ?? '.swrm/swrm.db'})\n`);
}

if (require.main === module) {
  startMcpServer().catch((err) => {
    process.stderr.write(`[swrm-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
