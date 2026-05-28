#!/usr/bin/env node
// swrm — CLI entry. `npx swrm` boots the server. `swrm mcp` boots the MCP
// stdio server (for embedding via .mcp.json).
//
// Args:
//   swrm                  → boot http server at $SWRM_PORT (default 5173)
//   swrm mcp              → boot MCP JSON-RPC stdio server
//   swrm plan --idea ...  → AI Project Breakdown CLI (delegates to plan)
//   swrm --version        → print version + exit
//   swrm --help           → print usage + exit

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`swrm v${readVersion()} — MCP-native kanban for parallel coding agents

USAGE:
  swrm                       Boot dashboard at http://localhost:$SWRM_PORT (default 5173)
  swrm mcp                   Boot MCP JSON-RPC stdio server (for .mcp.json)
  swrm plan --idea "..."     Generate a PRD from an idea (writes prd-<slug>.json)
  swrm --version             Print version
  swrm --help                Print this help

ENV:
  SWRM_PORT                  Override the http port
  SWRM_DB_PATH               Override the SQLite db path (default .swrm/swrm.db under cwd)
  PM_WORKTREE_ROOT           Override the git worktree root
  ANTHROPIC_API_KEY          Required for AI Project Breakdown (swrm plan)

DOCS: https://github.com/ballinbigE/swrm
`);
}

async function main(): Promise<void> {
  if (cmd === '--version' || cmd === '-v') {
    // eslint-disable-next-line no-console
    console.log(readVersion());
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }
  if (cmd === 'mcp') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startMcpServer } = require('./mcp/server') as typeof import('./mcp/server');
    await startMcpServer();
    return;
  }
  if (cmd === 'plan') {
    // plan.ts runs its CLI under require.main guard; invoking it directly
    // here would skip that. Delegate by re-exec'ing tsx/node on the module
    // is overkill — instead plan exposes runPlanCli().
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const planMod = require('./plan') as { runPlanCli?: () => Promise<void> };
    if (planMod.runPlanCli) await planMod.runPlanCli();
    return;
  }
  // Default: boot the http server (server.ts runs main() on import).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./server');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[swrm] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
