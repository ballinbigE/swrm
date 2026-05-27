// US-022 tests — GET /api/suggestions/today (heuristic-backed + rationale).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { getTodaysSuggestions } from '../api/suggestions';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-suggestions-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

function boardId(db: Database.Database, slug: string): number {
  return (db.prepare(`SELECT id FROM boards WHERE slug = ?`).get(slug) as { id: number }).id;
}

function seed(db: Database.Database, board_id: number, opts: {
  title: string;
  priority?: string | null;
  due_date?: string | null;
  effort_hours?: number | null;
  blockers?: string | null;
  status?: string;
  created_at_offset_days?: number;
}): number {
  const created = opts.created_at_offset_days != null
    ? `datetime('now', '-${opts.created_at_offset_days} days')`
    : `datetime('now')`;
  const r = db.prepare(
    `INSERT INTO tasks (board_id, title, status, priority, due_date, effort_hours, blockers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${created})`,
  ).run(
    board_id,
    opts.title,
    opts.status ?? 'backlog',
    opts.priority ?? null,
    opts.due_date ?? null,
    opts.effort_hours ?? null,
    opts.blockers ?? null,
  );
  return r.lastInsertRowid as number;
}

describe('getTodaysSuggestions - US-022', () => {
  test('empty board returns count 0 + empty list', () => {
    const db = freshDb();
    try {
      const res = getTodaysSuggestions(db);
      expect(res.count).toBe(0);
      expect(res.suggestions).toEqual([]);
      expect(res.generated_at).toMatch(/T/);
    } finally {
      db.close();
    }
  });

  test('returns top 5 by default, clamped 3..10', () => {
    const db = freshDb();
    try {
      const bid = boardId(db, 'personal');
      for (let i = 0; i < 8; i++) seed(db, bid, { title: `t${i}`, priority: 'medium' });

      const def = getTodaysSuggestions(db);
      expect(def.count).toBe(5);

      const lo = getTodaysSuggestions(db, { limit: 1 });
      expect(lo.count).toBe(3); // floor clamp

      const hi = getTodaysSuggestions(db, { limit: 100 });
      expect(hi.count).toBe(8); // capped by available, not by 10
    } finally {
      db.close();
    }
  });

  test('overdue + high pri ranks above future low pri', () => {
    const db = freshDb();
    try {
      const bid = boardId(db, 'personal');
      const future = seed(db, bid, { title: 'future low', priority: 'low', due_date: '2099-01-01' });
      const overdue = seed(db, bid, { title: 'overdue high', priority: 'high', due_date: '2020-01-01' });

      const res = getTodaysSuggestions(db);
      expect(res.suggestions[0].task_id).toBe(overdue);
      expect(res.suggestions[0].rationale).toMatch(/[Oo]verdue/);
      expect(res.suggestions[1].task_id).toBe(future);
    } finally {
      db.close();
    }
  });

  test('blocker task surfaces above its waiter at same priority', () => {
    const db = freshDb();
    try {
      const bid = boardId(db, 'personal');
      const unblocker = seed(db, bid, { title: 'unblocker', priority: 'low' });
      seed(db, bid, { title: 'waiter', priority: 'low', blockers: `blocked on #${unblocker}` });

      const res = getTodaysSuggestions(db);
      expect(res.suggestions[0].task_id).toBe(unblocker);
      expect(res.suggestions[0].rationale).toMatch(/[Uu]nblock/);
    } finally {
      db.close();
    }
  });

  test('quick-win rationale fires on small-effort med/high pri', () => {
    const db = freshDb();
    try {
      const bid = boardId(db, 'personal');
      seed(db, bid, { title: 'quick', priority: 'medium', effort_hours: 0.5 });
      const res = getTodaysSuggestions(db);
      expect(res.suggestions[0].rationale).toMatch(/[Qq]uick win/);
    } finally {
      db.close();
    }
  });

  test('done tasks excluded', () => {
    const db = freshDb();
    try {
      const bid = boardId(db, 'personal');
      seed(db, bid, { title: 'done one', priority: 'high', status: 'done' });
      seed(db, bid, { title: 'open one', priority: 'low' });
      const res = getTodaysSuggestions(db);
      expect(res.suggestions.map((s) => s.title)).toEqual(['open one']);
    } finally {
      db.close();
    }
  });

  test('board_id filter scopes to one board', () => {
    const db = freshDb();
    try {
      const personal = boardId(db, 'personal');
      const work = boardId(db, 'work');
      seed(db, personal, { title: 'personal task', priority: 'high' });
      seed(db, work, { title: 'work task', priority: 'high' });
      const res = getTodaysSuggestions(db, { board_id: personal });
      expect(res.suggestions.map((s) => s.title)).toEqual(['personal task']);
    } finally {
      db.close();
    }
  });
});
