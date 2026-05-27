// loom/src/config.ts — merged config layer.
//
// Read order (highest precedence first):
//   1. CLI args (parsed in cli.ts, passed in via opts)
//   2. Process env vars
//   3. .loomrc.local.json (gitignored — rep's local overrides)
//   4. .loomrc.json (committed — project defaults)
//   5. Hardcoded defaults
//
// Validates unknown top-level keys and surfaces them as errors so a typo
// in the rc file doesn't silently no-op.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LoomConfig {
  /** HTTP server port. Default 5173. */
  port: number;
  /** SQLite db file path. Default <cwd>/.loom/loom.db. */
  dbPath: string;
  /** Worktree root dir. Default ~/Library/Application Support/loom/worktrees. */
  worktreeRoot: string;
  /** Plugin package names to require() at boot (PreviewPlugin defaults). */
  plugins: string[];
  /** Map of agent_name → CLI binary path. */
  agentBinaries: Record<string, string>;
  /** Markdown → SQLite reconcile config. */
  syncMd: {
    enabled: boolean;
    files: string[];
  };
}

const KNOWN_KEYS: ReadonlySet<keyof LoomConfig> = new Set([
  'port',
  'dbPath',
  'worktreeRoot',
  'plugins',
  'agentBinaries',
  'syncMd',
]);

export const DEFAULTS: LoomConfig = {
  port: 5173,
  dbPath: path.join(process.cwd(), '.loom', 'loom.db'),
  worktreeRoot: path.join(os.homedir(), 'Library', 'Application Support', 'loom', 'worktrees'),
  plugins: [],
  agentBinaries: {
    'claude-code': 'claude',
    codex: 'codex',
    gemini: 'gemini',
  },
  syncMd: {
    enabled: false,
    files: [],
  },
};

function readJsonSafe(filePath: string): Partial<LoomConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LoomConfig>;
  } catch {
    return null;
  }
}

function validateKeys(config: Record<string, unknown>, source: string): string[] {
  const unknown: string[] = [];
  for (const k of Object.keys(config)) {
    if (!KNOWN_KEYS.has(k as keyof LoomConfig)) unknown.push(k);
  }
  return unknown.map((k) => `${source}: unknown key '${k}'`);
}

function fromEnv(): Partial<LoomConfig> {
  const out: Partial<LoomConfig> = {};
  if (process.env.LOOM_PORT) out.port = Number(process.env.LOOM_PORT);
  else if (process.env.DASHBOARD_PORT) out.port = Number(process.env.DASHBOARD_PORT);
  if (process.env.LOOM_DB_PATH) out.dbPath = process.env.LOOM_DB_PATH;
  else if (process.env.PM_DB_PATH) out.dbPath = process.env.PM_DB_PATH;
  if (process.env.PM_WORKTREE_ROOT) out.worktreeRoot = process.env.PM_WORKTREE_ROOT;
  if (process.env.LOOM_WORKTREE_ROOT) out.worktreeRoot = process.env.LOOM_WORKTREE_ROOT;
  return out;
}

export interface LoadConfigOpts {
  cwd?: string;
  /** CLI-parsed overrides (highest precedence). */
  cli?: Partial<LoomConfig>;
  /** Custom config path; overrides the .loomrc.json + .loomrc.local.json lookup. */
  configPath?: string;
  /** Throw on unknown keys (default true). */
  strict?: boolean;
}

export function loadConfig(opts: LoadConfigOpts = {}): LoomConfig {
  const cwd = opts.cwd ?? process.cwd();
  const strict = opts.strict !== false;

  let fileConfig: Partial<LoomConfig> = {};
  const errors: string[] = [];

  if (opts.configPath) {
    const f = readJsonSafe(opts.configPath);
    if (f) {
      fileConfig = f;
      errors.push(...validateKeys(f as Record<string, unknown>, opts.configPath));
    }
  } else {
    // .loomrc.json (committed) layered under .loomrc.local.json (gitignored)
    const baseFile = readJsonSafe(path.join(cwd, '.loomrc.json'));
    const localFile = readJsonSafe(path.join(cwd, '.loomrc.local.json'));
    if (baseFile) {
      errors.push(...validateKeys(baseFile as Record<string, unknown>, '.loomrc.json'));
      fileConfig = { ...fileConfig, ...baseFile };
    }
    if (localFile) {
      errors.push(...validateKeys(localFile as Record<string, unknown>, '.loomrc.local.json'));
      fileConfig = { ...fileConfig, ...localFile };
    }
  }

  if (errors.length > 0 && strict) {
    throw new Error(`loom config errors:\n  - ${errors.join('\n  - ')}`);
  }

  const envConfig = fromEnv();
  const cliConfig = opts.cli ?? {};

  // Manual deep-merge for syncMd + agentBinaries so partial overrides work
  const merged: LoomConfig = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
    agentBinaries: {
      ...DEFAULTS.agentBinaries,
      ...(fileConfig.agentBinaries ?? {}),
      ...(cliConfig.agentBinaries ?? {}),
    },
    syncMd: {
      ...DEFAULTS.syncMd,
      ...(fileConfig.syncMd ?? {}),
      ...(cliConfig.syncMd ?? {}),
    },
  };

  // Default DB path under cwd if not absolute (handles relative paths)
  if (!path.isAbsolute(merged.dbPath)) {
    merged.dbPath = path.join(cwd, merged.dbPath);
  }
  if (!path.isAbsolute(merged.worktreeRoot)) {
    merged.worktreeRoot = path.join(cwd, merged.worktreeRoot);
  }

  return merged;
}
