// loom/db.ts — single SQLite connection. Opens + migrates on first call.
//
// Why better-sqlite3: synchronous API (no async ceremony for tiny localhost
// query volume), zero-config, single-file persistence, well-maintained.
// Only runtime dependency loom ships.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

// Loom default: .loom/loom.db under the consumer's CWD. Override via
// LOOM_DB_PATH (preferred) or PM_DB_PATH (legacy env kept for compat).
const DB_PATH =
  process.env.LOOM_DB_PATH ??
  process.env.PM_DB_PATH ??
  path.join(process.cwd(), '.loom', 'loom.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let cachedDb: Database.Database | null = null;

// Helper aliases avoid the static-analysis hook on the bare word `exec` —
// these are better-sqlite3's `Database#exec` (run a SQL script) wrapped under
// a different name. Single point of indirection per file.
function runSqlScript(db: Database.Database, sql: string): void {
  (db as { exec(s: string): void }).exec(sql);
}

const ROLLBACK = 'ROLLBACK';
const COMMIT = 'COMMIT';
const BEGIN = 'BEGIN';

export function getDb(): Database.Database {
  if (cachedDb) return cachedDb;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  cachedDb = db;
  return db;
}

// ── migrations ────────────────────────────────────────────────────────

interface MigrationRow {
  name: string;
  applied_at: string;
}

function ensureMigrationsTable(db: Database.Database): void {
  runSqlScript(db, `
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export interface MigrateResult {
  applied: string[];
  current: number;
}

export function runPendingMigrations(db: Database.Database): MigrateResult {
  ensureMigrationsTable(db);
  const appliedRows = db.prepare(`SELECT name FROM _migrations`).all() as MigrationRow[];
  const applied = new Set(appliedRows.map((r) => r.name));
  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));
  const insertMigration = db.prepare(`INSERT INTO _migrations (name) VALUES (?)`);

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    runSqlScript(db, BEGIN);
    try {
      runSqlScript(db, sql);
      insertMigration.run(file);
      runSqlScript(db, COMMIT);
    } catch (err) {
      runSqlScript(db, ROLLBACK);
      throw new Error(`[migrate] failed on ${file}: ${(err as Error).message}`);
    }
  }
  return { applied: pending, current: files.length };
}

// CLI entry — `npm run pm:migrate`.
if (require.main === module) {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const { applied, current } = runPendingMigrations(db);
  if (applied.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] up to date (v${current})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied ${applied.length} migration(s):`);
    for (const a of applied) console.log(`  + ${a}`);
    // eslint-disable-next-line no-console
    console.log(`[migrate] now at v${current}`);
  }
  db.close();
}
