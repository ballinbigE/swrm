// US-005 tests — POST / PATCH / DELETE /api/tasks (pure-function layer).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { archiveTask, createTask, updateTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tasks-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('createTask', () => {
  test('happy path: title-only insert defaults to personal board + backlog status', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'first task' });
      expect(t.id).toBeGreaterThan(0);
      expect(t.title).toBe('first task');
      expect(t.status).toBe('backlog');
      expect(t.board_id).toBeGreaterThan(0);

      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(t.id) as {
        title: string; status: string; archived_at: string | null;
      };
      expect(row.title).toBe('first task');
      expect(row.archived_at).toBeNull();
    } finally {
      db.close();
    }
  });

  test('validation: missing title throws code=VALIDATION', () => {
    const db = freshDb();
    try {
      expect(() => createTask(db, { title: '' })).toThrow(/title is required/);
      try {
        createTask(db, { title: '   ' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });

  test('validation: invalid status / priority rejected', () => {
    const db = freshDb();
    try {
      expect(() => createTask(db, { title: 'x', status: 'banana' as any })).toThrow(/invalid status/);
      expect(() => createTask(db, { title: 'x', priority: 'urgent' as any })).toThrow(/invalid priority/);
    } finally {
      db.close();
    }
  });
});

describe('updateTask', () => {
  test('updates allowed fields; ignores unknown keys; returns true', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'a', status: 'todo' });
      const ok = updateTask(db, t.id, {
        title: 'a-updated',
        status: 'in_progress',
        // @ts-expect-error — invalid key intentionally to test ignore behavior
        bogus: 'nope',
      });
      expect(ok).toBe(true);

      const row = db.prepare(`SELECT title, status FROM tasks WHERE id = ?`).get(t.id) as {
        title: string; status: string;
      };
      expect(row.title).toBe('a-updated');
      expect(row.status).toBe('in_progress');
    } finally {
      db.close();
    }
  });

  test('returns false for unknown task id', () => {
    const db = freshDb();
    try {
      expect(updateTask(db, 99999, { title: 'noop' })).toBe(false);
    } finally {
      db.close();
    }
  });

  test('validation: invalid status throws code=VALIDATION', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'a' });
      try {
        updateTask(db, t.id, { status: 'wrong' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });
});

describe('archiveTask', () => {
  test('soft-deletes the task and does NOT touch subtasks', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'parent' });
      db.prepare(`INSERT INTO subtasks (task_id, title) VALUES (?, ?)`).run(t.id, 'child a');
      db.prepare(`INSERT INTO subtasks (task_id, title) VALUES (?, ?)`).run(t.id, 'child b');

      const ok = archiveTask(db, t.id);
      expect(ok).toBe(true);

      const row = db.prepare(`SELECT archived_at FROM tasks WHERE id = ?`).get(t.id) as { archived_at: string };
      expect(row.archived_at).toMatch(/\d{4}-\d{2}-\d{2}/);

      // Subtasks must still exist — soft-delete only.
      const subCount = (db.prepare(`SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?`).get(t.id) as { n: number }).n;
      expect(subCount).toBe(2);

      // Re-archiving an already-archived row returns false.
      expect(archiveTask(db, t.id)).toBe(false);
    } finally {
      db.close();
    }
  });
});
