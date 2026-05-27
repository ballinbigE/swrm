// US-006 tests — Epics CRUD + parent/child semantics.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { createEpic, deleteEpic, listEpicsWithCounts, updateEpic } from '../api/epics';
import { createTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-epics-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('createEpic', () => {
  test('happy path: title + board_id required', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const e = createEpic(db, { title: 'Q3 push', board_id: board.id });
      expect(e.id).toBeGreaterThan(0);
      expect(e.title).toBe('Q3 push');
      expect(e.status).toBe('open');
      expect(e.color).toBe('#f6c545');
    } finally {
      db.close();
    }
  });

  test('validation: missing title', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      try {
        createEpic(db, { title: '', board_id: board.id });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });

  test('validation: unknown board_id', () => {
    const db = freshDb();
    try {
      try {
        createEpic(db, { title: 'x', board_id: 99999 });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
        expect(err.message).toMatch(/board 99999 not found/);
      }
    } finally {
      db.close();
    }
  });
});

describe('listEpicsWithCounts', () => {
  test('epic with 3 open + 0 done child tasks returns correct counts', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const epic = createEpic(db, { title: 'parent', board_id: board.id });
      createTask(db, { title: 'a', board_id: board.id, epic_id: epic.id });
      createTask(db, { title: 'b', board_id: board.id, epic_id: epic.id, status: 'in_progress' });
      createTask(db, { title: 'c', board_id: board.id, epic_id: epic.id, status: 'review' });

      const all = listEpicsWithCounts(db);
      const found = all.find((x) => x.id === epic.id)!;
      expect(found.open_count).toBe(3);
      expect(found.done_count).toBe(0);
      expect(found.total_count).toBe(3);
    } finally {
      db.close();
    }
  });

  test('mixed open/done — done_count counts only status=done', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const epic = createEpic(db, { title: 'p', board_id: board.id });
      createTask(db, { title: '1', board_id: board.id, epic_id: epic.id, status: 'backlog' });
      createTask(db, { title: '2', board_id: board.id, epic_id: epic.id, status: 'done' });
      createTask(db, { title: '3', board_id: board.id, epic_id: epic.id, status: 'done' });

      const found = listEpicsWithCounts(db).find((x) => x.id === epic.id)!;
      expect(found.open_count).toBe(1);
      expect(found.done_count).toBe(2);
      expect(found.total_count).toBe(3);
    } finally {
      db.close();
    }
  });

  test('boardId filter limits results', () => {
    const db = freshDb();
    try {
      const personal = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const work = db.prepare(`SELECT id FROM boards WHERE slug = 'work'`).get() as { id: number };
      createEpic(db, { title: 'p1', board_id: personal.id });
      createEpic(db, { title: 'w1', board_id: work.id });

      expect(listEpicsWithCounts(db, personal.id)).toHaveLength(1);
      expect(listEpicsWithCounts(db, work.id)).toHaveLength(1);
      expect(listEpicsWithCounts(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

describe('updateEpic', () => {
  test('updates allowed fields; ignores unknown', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const e = createEpic(db, { title: 'old', board_id: board.id });
      const ok = updateEpic(db, e.id, {
        title: 'new',
        target_date: '2026-12-31',
        // @ts-expect-error — intentionally invalid
        bogus: 'nope',
      });
      expect(ok).toBe(true);
      const row = db.prepare(`SELECT title, target_date FROM epics WHERE id = ?`).get(e.id) as { title: string; target_date: string };
      expect(row.title).toBe('new');
      expect(row.target_date).toBe('2026-12-31');
    } finally {
      db.close();
    }
  });

  test('returns false for unknown id', () => {
    const db = freshDb();
    try {
      expect(updateEpic(db, 99999, { title: 'noop' })).toBe(false);
    } finally {
      db.close();
    }
  });

  test('validation: invalid status throws', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const e = createEpic(db, { title: 'x', board_id: board.id });
      try {
        updateEpic(db, e.id, { status: 'wrong' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });
});

describe('deleteEpic', () => {
  test('deletes the epic but leaves child tasks intact w/ epic_id NULL', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const epic = createEpic(db, { title: 'parent', board_id: board.id });
      const t1 = createTask(db, { title: 't1', board_id: board.id, epic_id: epic.id });
      const t2 = createTask(db, { title: 't2', board_id: board.id, epic_id: epic.id });

      expect(deleteEpic(db, epic.id)).toBe(true);

      // Epic gone
      expect(db.prepare(`SELECT id FROM epics WHERE id = ?`).get(epic.id)).toBeUndefined();

      // Tasks survive w/ epic_id nulled
      const r1 = db.prepare(`SELECT epic_id FROM tasks WHERE id = ?`).get(t1.id) as { epic_id: number | null };
      const r2 = db.prepare(`SELECT epic_id FROM tasks WHERE id = ?`).get(t2.id) as { epic_id: number | null };
      expect(r1.epic_id).toBeNull();
      expect(r2.epic_id).toBeNull();
    } finally {
      db.close();
    }
  });

  test('returns false for unknown id', () => {
    const db = freshDb();
    try {
      expect(deleteEpic(db, 99999)).toBe(false);
    } finally {
      db.close();
    }
  });
});
