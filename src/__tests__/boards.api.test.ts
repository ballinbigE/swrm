// US-004 tests — boards + tasks GET endpoints.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { listBoards, listTasksForBoard } from '../api/boards';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-boards-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

describe('listBoards', () => {
  test('returns 3 seeded boards with zero counts when no tasks', () => {
    const db = freshDb();
    try {
      const boards = listBoards(db);
      expect(boards).toHaveLength(3);
      expect(boards.map((b) => b.slug)).toEqual(['personal', 'ai-agent-tasks', 'work']);
      for (const b of boards) {
        expect(b.counts).toEqual({ backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 });
        expect(b.total_open).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  test('aggregates per-column counts (excl. archived); total_open excludes done', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const insert = db.prepare(
        `INSERT INTO tasks (board_id, title, status) VALUES (?, ?, ?)`,
      );
      insert.run(board.id, 'a1', 'backlog');
      insert.run(board.id, 'a2', 'backlog');
      insert.run(board.id, 'b1', 'in_progress');
      insert.run(board.id, 'c1', 'done');
      insert.run(board.id, 'c2', 'done');
      // archived row should be ignored
      db.prepare(
        `INSERT INTO tasks (board_id, title, status, archived_at) VALUES (?, ?, ?, datetime('now'))`,
      ).run(board.id, 'archived', 'todo');

      const boards = listBoards(db);
      const personal = boards.find((b) => b.slug === 'personal')!;
      expect(personal.counts).toEqual({
        backlog: 2, todo: 0, in_progress: 1, review: 0, done: 2,
      });
      expect(personal.total_open).toBe(3); // backlog 2 + in_progress 1
    } finally {
      db.close();
    }
  });
});

describe('listTasksForBoard', () => {
  test('returns tasks with labels + subtask counts, in stable order', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'personal'`).get() as { id: number };
      const bug = db.prepare(`SELECT id FROM labels WHERE name = 'bug'`).get() as { id: number };
      const feature = db.prepare(`SELECT id FROM labels WHERE name = 'feature'`).get() as { id: number };

      const t1 = db
        .prepare(`INSERT INTO tasks (board_id, title, status, position, priority) VALUES (?, ?, ?, ?, ?)`)
        .run(board.id, 'first', 'todo', 0, 'high').lastInsertRowid as number;
      const t2 = db
        .prepare(`INSERT INTO tasks (board_id, title, status, position) VALUES (?, ?, ?, ?)`)
        .run(board.id, 'second', 'todo', 1).lastInsertRowid as number;

      db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`).run(t1, bug.id);
      db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`).run(t1, feature.id);

      db.prepare(`INSERT INTO subtasks (task_id, title, done) VALUES (?, ?, ?)`).run(t1, 's1', 1);
      db.prepare(`INSERT INTO subtasks (task_id, title, done) VALUES (?, ?, ?)`).run(t1, 's2', 0);
      db.prepare(`INSERT INTO subtasks (task_id, title, done) VALUES (?, ?, ?)`).run(t1, 's3', 1);

      const tasks = listTasksForBoard(db, board.id);
      expect(tasks).toHaveLength(2);

      const first = tasks.find((t) => t.id === t1)!;
      expect(first.title).toBe('first');
      expect(first.labels.map((l) => l.name)).toEqual(['bug', 'feature']);
      expect(first.subtasks_total).toBe(3);
      expect(first.subtasks_done).toBe(2);
      expect(first.priority).toBe('high');

      const second = tasks.find((t) => t.id === t2)!;
      expect(second.labels).toEqual([]);
      expect(second.subtasks_total).toBe(0);
      expect(second.subtasks_done).toBe(0);
    } finally {
      db.close();
    }
  });

  test('returns [] for board with no tasks', () => {
    const db = freshDb();
    try {
      const board = db.prepare(`SELECT id FROM boards WHERE slug = 'work'`).get() as { id: number };
      expect(listTasksForBoard(db, board.id)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
