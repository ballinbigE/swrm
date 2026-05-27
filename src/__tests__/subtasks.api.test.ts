// US-007 tests — subtasks CRUD.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { listTasksForBoard } from '../api/boards';
import { createSubtask, deleteSubtask, updateSubtask } from '../api/subtasks';
import { createTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-subtasks-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('createSubtask', () => {
  test('appends a subtask with auto-assigned position', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'parent' });
      const s1 = createSubtask(db, t.id, { title: 'a' });
      const s2 = createSubtask(db, t.id, { title: 'b' });
      const s3 = createSubtask(db, t.id, { title: 'c' });
      expect(s1.position).toBe(0);
      expect(s2.position).toBe(1);
      expect(s3.position).toBe(2);
      expect(s1.done).toBe(0);
    } finally {
      db.close();
    }
  });

  test('validation: missing title throws', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      try {
        createSubtask(db, t.id, { title: '' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });

  test('not-found: unknown task_id throws code=NOT_FOUND', () => {
    const db = freshDb();
    try {
      try {
        createSubtask(db, 99999, { title: 'x' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    } finally {
      db.close();
    }
  });

  test('PRD acceptance: 5 subtasks w/ 2 done aggregates correctly via listTasksForBoard', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'parent' });
      createSubtask(db, t.id, { title: 's1', done: true });
      createSubtask(db, t.id, { title: 's2' });
      createSubtask(db, t.id, { title: 's3', done: true });
      createSubtask(db, t.id, { title: 's4' });
      createSubtask(db, t.id, { title: 's5' });

      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const tasks = listTasksForBoard(db, board.id);
      const parent = tasks.find((x) => x.id === t.id)!;
      expect(parent.subtasks_total).toBe(5);
      expect(parent.subtasks_done).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('updateSubtask', () => {
  test('toggle done: false → true → false', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const s = createSubtask(db, t.id, { title: 'x' });
      expect(updateSubtask(db, s.id, { done: true })).toBe(true);
      let row = db.prepare(`SELECT done FROM subtasks WHERE id = ?`).get(s.id) as { done: number };
      expect(row.done).toBe(1);
      expect(updateSubtask(db, s.id, { done: false })).toBe(true);
      row = db.prepare(`SELECT done FROM subtasks WHERE id = ?`).get(s.id) as { done: number };
      expect(row.done).toBe(0);
    } finally {
      db.close();
    }
  });

  test('edit title (trimmed); empty rejected', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const s = createSubtask(db, t.id, { title: 'old' });
      expect(updateSubtask(db, s.id, { title: '  new  ' })).toBe(true);
      const row = db.prepare(`SELECT title FROM subtasks WHERE id = ?`).get(s.id) as { title: string };
      expect(row.title).toBe('new');
      try {
        updateSubtask(db, s.id, { title: '   ' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });

  test('returns false for unknown id', () => {
    const db = freshDb();
    try {
      expect(updateSubtask(db, 99999, { done: true })).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('deleteSubtask', () => {
  test('removes the subtask; counts on parent task drop', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const s1 = createSubtask(db, t.id, { title: 'a' });
      const s2 = createSubtask(db, t.id, { title: 'b' });

      expect(deleteSubtask(db, s1.id)).toBe(true);

      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const tasks = listTasksForBoard(db, board.id);
      const parent = tasks.find((x) => x.id === t.id)!;
      expect(parent.subtasks_total).toBe(1);
      expect(parent.subtasks_done).toBe(0);

      // s2 still around
      expect(db.prepare(`SELECT id FROM subtasks WHERE id = ?`).get(s2.id)).toBeDefined();
    } finally {
      db.close();
    }
  });

  test('returns false for unknown id', () => {
    const db = freshDb();
    try {
      expect(deleteSubtask(db, 99999)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('cascade: archiving parent task does NOT delete subtasks (US-005 already verified — sanity here)', () => {
  test('subtasks survive parent task soft-delete', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const s = createSubtask(db, t.id, { title: 'child' });
      db.prepare(`UPDATE tasks SET archived_at = datetime('now') WHERE id = ?`).run(t.id);
      const row = db.prepare(`SELECT id FROM subtasks WHERE id = ?`).get(s.id);
      expect(row).toBeDefined();
    } finally {
      db.close();
    }
  });
});
