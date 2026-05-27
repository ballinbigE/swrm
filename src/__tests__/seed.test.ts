// US-002 tests — seed default boards + labels.
// Uses an isolated in-memory-ish temp DB so production pm.db is never touched.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runPendingMigrations } from '../db';
import { DEFAULT_BOARDS, DEFAULT_LABELS, seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-seed-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  return db;
}

describe('seedDefaults', () => {
  test('empty DB → inserts 3 boards + 6 labels', () => {
    const db = freshDb();
    try {
      const r = seedDefaults(db);
      expect(r.skipped).toBe(false);
      expect(r.boards_inserted).toBe(DEFAULT_BOARDS.length);
      expect(r.labels_inserted).toBe(DEFAULT_LABELS.length);

      const boardCount = (db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n;
      const labelCount = (db.prepare(`SELECT COUNT(*) AS n FROM labels`).get() as { n: number }).n;
      expect(boardCount).toBe(3);
      expect(labelCount).toBe(6);
    } finally {
      db.close();
    }
  });

  test('idempotent — second seed skips by default', () => {
    const db = freshDb();
    try {
      seedDefaults(db);
      const r2 = seedDefaults(db);
      expect(r2.skipped).toBe(true);
      expect(r2.reason).toMatch(/non-empty/);

      const boardCount = (db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n;
      expect(boardCount).toBe(3);
    } finally {
      db.close();
    }
  });

  test('--force re-runs but UPSERT keeps counts stable', () => {
    const db = freshDb();
    try {
      seedDefaults(db);
      const r2 = seedDefaults(db, { force: true });
      // force runs the inserts, but ON CONFLICT DO NOTHING keeps counts at 0
      expect(r2.skipped).toBe(false);
      expect(r2.boards_inserted).toBe(0);
      expect(r2.labels_inserted).toBe(0);

      const boardCount = (db.prepare(`SELECT COUNT(*) AS n FROM boards`).get() as { n: number }).n;
      expect(boardCount).toBe(3);
    } finally {
      db.close();
    }
  });

  test('boards have expected slugs + positions', () => {
    const db = freshDb();
    try {
      seedDefaults(db);
      const rows = db
        .prepare(`SELECT slug, position FROM boards ORDER BY position`)
        .all() as Array<{ slug: string; position: number }>;
      expect(rows).toEqual([
        { slug: 'personal',       position: 0 },
        { slug: 'ai-agent-tasks', position: 1 },
        { slug: 'work',           position: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  test('labels are global (board_id IS NULL)', () => {
    const db = freshDb();
    try {
      seedDefaults(db);
      const globals = (
        db.prepare(`SELECT COUNT(*) AS n FROM labels WHERE board_id IS NULL`).get() as { n: number }
      ).n;
      expect(globals).toBe(6);
    } finally {
      db.close();
    }
  });
});
