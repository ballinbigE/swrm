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

async function main(): Promise<void> {
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

  // Crash banner to stderr so the client knows the process started.
  process.stderr.write(`[pm-mcp] ready (db=${process.env.PM_DB_PATH ?? 'tasks/pm.db'})\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[pm-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
