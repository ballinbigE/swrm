// swrm/src/config.ts — merged config layer.
//
// Read order (highest precedence first):
//   1. CLI args (parsed in cli.ts, passed in via opts)
//   2. Process env vars
//   3. .swrmrc.local.json (gitignored — rep's local overrides)
//   4. .swrmrc.json (committed — project defaults)
//   5. Hardcoded defaults
//
// Validates unknown top-level keys and surfaces them as errors so a typo
// in the rc file doesn't silently no-op.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SwrmConfig {
  /** HTTP server port. Default 5173. */
  port: number;
  /** SQLite db file path. Default <cwd>/.swrm/swrm.db. */
  dbPath: string;
  /** Worktree root dir. Default ~/Library/Application Support/swrm/worktrees. */
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

const KNOWN_KEYS: ReadonlySet<keyof SwrmConfig> = new Set([
  'port',
  'dbPath',
  'worktreeRoot',
  'plugins',
  'agentBinaries',
  'syncMd',
]);

export const DEFAULTS: SwrmConfig = {
  port: 5173,
  dbPath: path.join(process.cwd(), '.swrm', 'swrm.db'),
  worktreeRoot: path.join(os.homedir(), 'Library', 'Application Support', 'swrm', 'worktrees'),
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

function readJsonSafe(filePath: string): Partial<SwrmConfig> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SwrmConfig>;
  } catch {
    return null;
  }
}

function validateKeys(config: Record<string, unknown>, source: string): string[] {
  const unknown: string[] = [];
  for (const k of Object.keys(config)) {
    if (!KNOWN_KEYS.has(k as keyof SwrmConfig)) unknown.push(k);
  }
  return unknown.map((k) => `${source}: unknown key '${k}'`);
}

function fromEnv(): Partial<SwrmConfig> {
  const out: Partial<SwrmConfig> = {};
  if (process.env.SWRM_PORT) out.port = Number(process.env.SWRM_PORT);
  else if (process.env.DASHBOARD_PORT) out.port = Number(process.env.DASHBOARD_PORT);
  if (process.env.SWRM_DB_PATH) out.dbPath = process.env.SWRM_DB_PATH;
  else if (process.env.PM_DB_PATH) out.dbPath = process.env.PM_DB_PATH;
  if (process.env.PM_WORKTREE_ROOT) out.worktreeRoot = process.env.PM_WORKTREE_ROOT;
  if (process.env.SWRM_WORKTREE_ROOT) out.worktreeRoot = process.env.SWRM_WORKTREE_ROOT;
  return out;
}

export interface LoadConfigOpts {
  cwd?: string;
  /** CLI-parsed overrides (highest precedence). */
  cli?: Partial<SwrmConfig>;
  /** Custom config path; overrides the .swrmrc.json + .swrmrc.local.json lookup. */
  configPath?: string;
  /** Throw on unknown keys (default true). */
  strict?: boolean;
}

export function loadConfig(opts: LoadConfigOpts = {}): SwrmConfig {
  const cwd = opts.cwd ?? process.cwd();
  const strict = opts.strict !== false;

  let fileConfig: Partial<SwrmConfig> = {};
  const errors: string[] = [];

  if (opts.configPath) {
    const f = readJsonSafe(opts.configPath);
    if (f) {
      fileConfig = f;
      errors.push(...validateKeys(f as Record<string, unknown>, opts.configPath));
    }
  } else {
    // .swrmrc.json (committed) layered under .swrmrc.local.json (gitignored)
    const baseFile = readJsonSafe(path.join(cwd, '.swrmrc.json'));
    const localFile = readJsonSafe(path.join(cwd, '.swrmrc.local.json'));
    if (baseFile) {
      errors.push(...validateKeys(baseFile as Record<string, unknown>, '.swrmrc.json'));
      fileConfig = { ...fileConfig, ...baseFile };
    }
    if (localFile) {
      errors.push(...validateKeys(localFile as Record<string, unknown>, '.swrmrc.local.json'));
      fileConfig = { ...fileConfig, ...localFile };
    }
  }

  if (errors.length > 0 && strict) {
    throw new Error(`swrm config errors:\n  - ${errors.join('\n  - ')}`);
  }

  const envConfig = fromEnv();
  const cliConfig = opts.cli ?? {};

  // Manual deep-merge for syncMd + agentBinaries so partial overrides work
  const merged: SwrmConfig = {
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
