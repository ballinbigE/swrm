// scripts/pm/seed.ts — first-boot seed for Personal AI PM System.
// Inserts 3 default boards (Personal, AI Agent Tasks, Work) + 6 default
// labels (bug, feature, perf, design, refactor, blocked).
//
// Per US-002 of tasks/prd-personal-ai-pm-system.md.
//
// Idempotent: skips if `boards` is non-empty unless --force.

import type Database from 'better-sqlite3';

import { getDb } from './db';

export interface BoardSeed {
  slug: string;
  name: string;
  color: string;
  position: number;
}
export interface LabelSeed {
  name: string;
  color: string;
}

export const DEFAULT_BOARDS: BoardSeed[] = [
  { slug: 'personal',        name: 'Personal',        color: '#60a5fa', position: 0 },
  { slug: 'ai-agent-tasks',  name: 'AI Agent Tasks',  color: '#d97757', position: 1 },
  { slug: 'work',            name: 'Work',            color: '#34d399', position: 2 },
];

export const DEFAULT_LABELS: LabelSeed[] = [
  { name: 'bug',       color: '#ef5350' },
  { name: 'feature',   color: '#60a5fa' },
  { name: 'perf',      color: '#f6c545' },
  { name: 'design',    color: '#d97757' },
  { name: 'refactor',  color: '#a78bfa' },
  { name: 'blocked',   color: '#f59e0b' },
];

export interface SeedResult {
  skipped: boolean;
  boards_inserted: number;
  labels_inserted: number;
  reason?: string;
}

export function seedDefaults(
  db: Database.Database,
  opts: { force?: boolean } = {},
): SeedResult {
  const boardCount = (db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n;
  if (boardCount > 0 && !opts.force) {
    return { skipped: true, boards_inserted: 0, labels_inserted: 0, reason: 'boards non-empty' };
  }

  const insertBoard = db.prepare(
    `INSERT INTO boards (slug, name, color, position) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO NOTHING`,
  );
  // SQLite treats NULL as not-equal-to-NULL in UNIQUE indexes, so a global
  // label (board_id IS NULL) cannot rely on ON CONFLICT for dedupe — use an
  // explicit WHERE NOT EXISTS check instead.
  const insertLabel = db.prepare(
    `INSERT INTO labels (name, color, board_id)
     SELECT ?, ?, NULL
     WHERE NOT EXISTS (SELECT 1 FROM labels WHERE name = ? AND board_id IS NULL)`,
  );

  let boards_inserted = 0;
  let labels_inserted = 0;

  const tx = db.transaction(() => {
    for (const b of DEFAULT_BOARDS) {
      const r = insertBoard.run(b.slug, b.name, b.color, b.position);
      if (r.changes > 0) boards_inserted += 1;
    }
    for (const l of DEFAULT_LABELS) {
      const r = insertLabel.run(l.name, l.color, l.name);
      if (r.changes > 0) labels_inserted += 1;
    }
  });
  tx();

  return { skipped: false, boards_inserted, labels_inserted };
}

// CLI — `npm run pm:seed [-- --force]`.
if (require.main === module) {
  const force = process.argv.includes('--force');
  const db = getDb();
  const res = seedDefaults(db, { force });
  if (res.skipped) {
    // eslint-disable-next-line no-console
    console.log(`[seed] skipped (${res.reason}); use --force to override`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[seed] inserted ${res.boards_inserted} board(s), ${res.labels_inserted} label(s)`);
  }
  db.close();
}
