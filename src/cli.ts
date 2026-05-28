#!/usr/bin/env node
// loom — CLI entry. `npx loom` boots the server. `loom mcp` boots the MCP
// stdio server (for embedding via .mcp.json).
//
// Args:
//   loom                  → boot http server at $LOOM_PORT (default 5173)
//   loom mcp              → boot MCP JSON-RPC stdio server
//   loom plan --idea ...  → AI Project Breakdown CLI (delegates to plan)
//   loom --version        → print version + exit
//   loom --help           → print usage + exit

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
  console.log(`loom v${readVersion()} — MCP-native kanban for parallel coding agents

USAGE:
  loom                       Boot dashboard at http://localhost:$LOOM_PORT (default 5173)
  loom mcp                   Boot MCP JSON-RPC stdio server (for .mcp.json)
  loom plan --idea "..."     Generate a PRD from an idea (writes prd-<slug>.json)
  loom --version             Print version
  loom --help                Print this help

ENV:
  LOOM_PORT                  Override the http port
  LOOM_DB_PATH               Override the SQLite db path (default .loom/loom.db under cwd)
  PM_WORKTREE_ROOT           Override the git worktree root
  ANTHROPIC_API_KEY          Required for AI Project Breakdown (loom plan)

DOCS: https://github.com/ballinbigE/loom
`);
}

function main(): void {
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
    require('./mcp/server');
    return;
  }
  if (cmd === 'plan') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./plan');
    return;
  }
  // Default: boot the http server
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./server');
}

main();
