// swrm/src/__tests__/import_project.test.ts
// Tests for importProject — merging a source swrm DB into a target project.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runPendingMigrations } from '../db';
import { createProject } from '../api/projects';
import { importProject } from '../import_project';

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Create a fresh migrated DB. Also inserts a board for the default project
 * so it can act as a source or target without requiring full seed.
 */
function freshDb(): { db: Database.Database; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swrm-import-test-'));
  const dbPath = path.join(dir, 'swrm.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);

  // Seed one board for the default project (migration creates the project but
  // not its board — seed.ts normally does that, but we avoid importing seed here).
  const defaultProject = db
    .prepare(`SELECT id FROM projects WHERE slug = 'default'`)
    .get() as { id: number } | undefined;
  if (defaultProject) {
    db.prepare(
      `INSERT OR IGNORE INTO boards (slug, name, color, position, project_id)
       VALUES ('default', 'Default', '#60a5fa', 0, ?)`,
    ).run(defaultProject.id);
  }

  return { db, dbPath };
}

function insertTask(
  db: Database.Database,
  boardId: number,
  overrides: Partial<{
    title: string;
    status: string;
    priority: string;
    description: string;
    effort_hours: number;
    due_date: string;
    position: number;
  }> = {},
  index = 0,
): void {
  const title = overrides.title ?? `Task ${index + 1}`;
  const status = overrides.status ?? 'todo';
  const priority = overrides.priority ?? 'medium';
  const description = overrides.description ?? null;
  const effort_hours = overrides.effort_hours ?? null;
  const due_date = overrides.due_date ?? null;
  const position = overrides.position ?? index;

  db.prepare(
    `INSERT INTO tasks (board_id, epic_id, title, description, status, priority, effort_hours, due_date, position, external_md_ref)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(boardId, title, description, status, priority, effort_hours, due_date, position);
}

function getFirstBoardId(db: Database.Database): number {
  const row = db
    .prepare(`SELECT id FROM boards ORDER BY position, id LIMIT 1`)
    .get() as { id: number };
  return row.id;
}

const REAL_DIR = os.tmpdir();

// ── tests ────────────────────────────────────────────────────────────────

describe('importProject — happy path', () => {
  test('imports all non-archived tasks from source into target board', () => {
    const source = freshDb();
    const target = freshDb();

    try {
      const sourceBoardId = getFirstBoardId(source.db);

      // Insert 3 tasks with varied statuses on source board.
      insertTask(source.db, sourceBoardId, { title: 'Alpha task', status: 'backlog' }, 0);
      insertTask(source.db, sourceBoardId, { title: 'Beta task', status: 'in_progress' }, 1);
      insertTask(source.db, sourceBoardId, { title: 'Gamma task', status: 'done' }, 2);

      // Also insert an archived task — it should NOT be imported.
      source.db
        .prepare(
          `INSERT INTO tasks (board_id, title, status, position, archived_at)
           VALUES (?, 'Archived task', 'done', 99, datetime('now'))`,
        )
        .run(sourceBoardId);

      // Target already has the 'default' project from migration.
      const result = importProject(target.db, {
        sourceDbPath: source.dbPath,
        projectSlug: 'default',
      });

      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.total).toBe(3);
      expect(typeof result.boardSlug).toBe('string');

      // Verify tasks were actually written.
      const targetTasks = target.db
        .prepare(`SELECT title, status FROM tasks ORDER BY position, id`)
        .all() as Array<{ title: string; status: string }>;

      const titles = targetTasks.map((t) => t.title);
      expect(titles).toContain('Alpha task');
      expect(titles).toContain('Beta task');
      expect(titles).toContain('Gamma task');
      expect(titles).not.toContain('Archived task');

      // Status is preserved.
      const alpha = targetTasks.find((t) => t.title === 'Alpha task')!;
      expect(alpha.status).toBe('backlog');
      const beta = targetTasks.find((t) => t.title === 'Beta task')!;
      expect(beta.status).toBe('in_progress');
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  test('imports into a non-default project board when specified', () => {
    const source = freshDb();
    const target = freshDb();

    try {
      const sourceBoardId = getFirstBoardId(source.db);
      insertTask(source.db, sourceBoardId, { title: 'Import me', status: 'todo' }, 0);
      insertTask(source.db, sourceBoardId, { title: 'Import me too', status: 'review' }, 1);

      // Create a second project in target.
      const newProject = createProject(target.db, {
        slug: 'my-project',
        name: 'My Project',
        root_path: REAL_DIR,
      });

      const result = importProject(target.db, {
        sourceDbPath: source.dbPath,
        projectSlug: 'my-project',
      });

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.total).toBe(2);
      expect(result.boardSlug).toBe(newProject.slug);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe('importProject — deduplication', () => {
  test('re-running import skips all tasks (dedup by title)', () => {
    const source = freshDb();
    const target = freshDb();

    try {
      const sourceBoardId = getFirstBoardId(source.db);
      insertTask(source.db, sourceBoardId, { title: 'Dedup task A', status: 'todo' }, 0);
      insertTask(source.db, sourceBoardId, { title: 'Dedup task B', status: 'done' }, 1);

      // First run — should import both.
      const first = importProject(target.db, {
        sourceDbPath: source.dbPath,
        projectSlug: 'default',
      });
      expect(first.imported).toBe(2);
      expect(first.skipped).toBe(0);

      // Second run — both should be skipped.
      const second = importProject(target.db, {
        sourceDbPath: source.dbPath,
        projectSlug: 'default',
      });
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.total).toBe(2);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  test('only skips tasks whose title already exists; new tasks are imported', () => {
    const source = freshDb();
    const target = freshDb();

    try {
      const targetBoardId = getFirstBoardId(target.db);
      // Pre-populate target with one task.
      insertTask(target.db, targetBoardId, { title: 'Already here', status: 'todo' }, 0);

      const sourceBoardId = getFirstBoardId(source.db);
      insertTask(source.db, sourceBoardId, { title: 'Already here', status: 'backlog' }, 0);
      insertTask(source.db, sourceBoardId, { title: 'Brand new', status: 'in_progress' }, 1);

      const result = importProject(target.db, {
        sourceDbPath: source.dbPath,
        projectSlug: 'default',
      });

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(2);
    } finally {
      source.db.close();
      target.db.close();
    }
  });
});

describe('importProject — error cases', () => {
  test('throws a clear error for unknown project slug', () => {
    const source = freshDb();
    const target = freshDb();

    try {
      expect(() =>
        importProject(target.db, {
          sourceDbPath: source.dbPath,
          projectSlug: 'does-not-exist',
        }),
      ).toThrow(/project 'does-not-exist' not found/);
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  test('throws when source DB file does not exist', () => {
    const target = freshDb();

    try {
      const missingPath = path.join(os.tmpdir(), 'swrm-missing-db-99999.db');
      expect(() =>
        importProject(target.db, {
          sourceDbPath: missingPath,
          projectSlug: 'default',
        }),
      ).toThrow();
    } finally {
      target.db.close();
    }
  });
});
