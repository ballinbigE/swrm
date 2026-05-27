// US-008 tests — labels + task-label join.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { listTasksForBoard } from '../api/boards';
import { attachLabel, createLabel, detachLabel, listLabels } from '../api/labels';
import { createTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-labels-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('createLabel', () => {
  test('creates a global label with default color', () => {
    const db = freshDb();
    try {
      const l = createLabel(db, { name: 'p0' });
      expect(l.name).toBe('p0');
      expect(l.color).toBe('#34d399');
      expect(l.board_id).toBeNull();
    } finally {
      db.close();
    }
  });

  test('creates a board-scoped label', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const l = createLabel(db, { name: 'home', color: '#abc', board_id: board.id });
      expect(l.board_id).toBe(board.id);
      expect(l.color).toBe('#abc');
    } finally {
      db.close();
    }
  });

  test('CONFLICT: duplicate global name rejected', () => {
    const db = freshDb();
    try {
      // 'bug' already seeded as global; second insert should conflict.
      try {
        createLabel(db, { name: 'bug' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('CONFLICT');
      }
    } finally {
      db.close();
    }
  });

  test('VALIDATION: missing name', () => {
    const db = freshDb();
    try {
      try {
        createLabel(db, { name: '' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('VALIDATION');
      }
    } finally {
      db.close();
    }
  });
});

describe('listLabels', () => {
  test('no args returns all (6 seeded globals)', () => {
    const db = freshDb();
    try {
      expect(listLabels(db)).toHaveLength(6);
    } finally {
      db.close();
    }
  });

  test('board_id filter returns scoped + global', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      createLabel(db, { name: 'home', board_id: board.id });
      const rows = listLabels(db, board.id);
      // 6 globals + 1 scoped
      expect(rows).toHaveLength(7);
    } finally {
      db.close();
    }
  });

  test('null filter returns globals only', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      createLabel(db, { name: 'home', board_id: board.id });
      expect(listLabels(db, null)).toHaveLength(6);
    } finally {
      db.close();
    }
  });
});

describe('attachLabel', () => {
  test('attaches by label_id; idempotent re-attach is a no-op', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const bug = db.prepare(`SELECT id FROM labels WHERE name = 'bug'`).get() as { id: number };
      attachLabel(db, t.id, { label_id: bug.id });
      attachLabel(db, t.id, { label_id: bug.id }); // duplicate — INSERT OR IGNORE

      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const tasks = listTasksForBoard(db, board.id);
      const parent = tasks.find((x) => x.id === t.id)!;
      expect(parent.labels).toHaveLength(1);
      expect(parent.labels[0].name).toBe('bug');
    } finally {
      db.close();
    }
  });

  test('attach-by-name auto-creates the global label when missing', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const r = attachLabel(db, t.id, { name: 'newlabel' });
      expect(r.created_label).toBe(true);

      // re-attach by name should find existing — created_label=false
      const r2 = attachLabel(db, t.id, { name: 'newlabel' });
      expect(r2.created_label).toBe(false);

      const all = listLabels(db).filter((l) => l.name === 'newlabel');
      expect(all).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('multiple labels on one task render in alpha order via listTasksForBoard', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      ['feature', 'perf', 'bug'].forEach((n) => {
        const id = (db.prepare(`SELECT id FROM labels WHERE name = ?`).get(n) as { id: number }).id;
        attachLabel(db, t.id, { label_id: id });
      });

      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const tasks = listTasksForBoard(db, board.id);
      const parent = tasks.find((x) => x.id === t.id)!;
      expect(parent.labels.map((l) => l.name)).toEqual(['bug', 'feature', 'perf']);
    } finally {
      db.close();
    }
  });

  test('NOT_FOUND: unknown task_id', () => {
    const db = freshDb();
    try {
      try {
        attachLabel(db, 99999, { name: 'x' });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    } finally {
      db.close();
    }
  });
});

describe('detachLabel', () => {
  test('removes the join row; counts reflect', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const bug = db.prepare(`SELECT id FROM labels WHERE name = 'bug'`).get() as { id: number };
      attachLabel(db, t.id, { label_id: bug.id });

      expect(detachLabel(db, t.id, bug.id)).toBe(true);
      expect(detachLabel(db, t.id, bug.id)).toBe(false); // already detached

      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const tasks = listTasksForBoard(db, board.id);
      const parent = tasks.find((x) => x.id === t.id)!;
      expect(parent.labels).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('label deletion cascades join rows', () => {
  test('deleting a label removes all its attachments', () => {
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'p' });
      const bug = db.prepare(`SELECT id FROM labels WHERE name = 'bug'`).get() as { id: number };
      attachLabel(db, t.id, { label_id: bug.id });

      db.prepare(`DELETE FROM labels WHERE id = ?`).run(bug.id);

      const count = (db.prepare(`SELECT COUNT(*) AS n FROM task_labels WHERE label_id = ?`).get(bug.id) as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });
});
