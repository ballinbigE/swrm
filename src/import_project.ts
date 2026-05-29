// swrm/src/import_project.ts — merge an existing swrm SQLite DB's tasks into
// the current unified DB under a target project's first board.
//
// v1 scope: copies title/description/status/priority/effort_hours/due_date/
// position; skips epics and archived tasks; deduplicates by title.

import Database from 'better-sqlite3';

import { getProjectBySlug } from './api/projects';

// ── types ────────────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
  boardSlug: string;
}

interface SourceTask {
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  effort_hours: number | null;
  due_date: string | null;
  position: number | null;
}

interface BoardRow {
  id: number;
  slug: string;
}

// ── main export ──────────────────────────────────────────────────────────

export function importProject(
  targetDb: Database.Database,
  opts: { sourceDbPath: string; projectSlug: string },
): ImportResult {
  const { sourceDbPath, projectSlug } = opts;

  // 1. Resolve target project.
  const project = getProjectBySlug(targetDb, projectSlug);
  if (!project) {
    throw new Error(`[import-project] project '${projectSlug}' not found in target DB`);
  }

  // 2. Resolve target board — first board of the project.
  const targetBoard = targetDb
    .prepare(
      `SELECT id, slug FROM boards WHERE project_id = ? ORDER BY position, id LIMIT 1`,
    )
    .get(project.id) as BoardRow | undefined;
  if (!targetBoard) {
    throw new Error(
      `[import-project] project '${projectSlug}' has no boards in target DB`,
    );
  }

  // 3. Open source DB read-only.
  const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  try {
    // 4. Read source non-archived tasks.
    const sourceTasks = sourceDb
      .prepare(
        `SELECT title, description, status, priority, effort_hours, due_date, position
         FROM tasks
         WHERE archived_at IS NULL
         ORDER BY position, id`,
      )
      .all() as SourceTask[];

    const total = sourceTasks.length;

    // Prepared statements on the target DB.
    const checkDup = targetDb.prepare(
      `SELECT 1 FROM tasks WHERE board_id = ? AND title = ?`,
    );
    const insertTask = targetDb.prepare(
      `INSERT INTO tasks (board_id, epic_id, title, description, status, priority, effort_hours, due_date, position, external_md_ref)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );

    let imported = 0;
    let skipped = 0;

    const tx = targetDb.transaction(() => {
      for (const task of sourceTasks) {
        const dup = checkDup.get(targetBoard.id, task.title);
        if (dup) {
          skipped += 1;
        } else {
          insertTask.run(
            targetBoard.id,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.effort_hours,
            task.due_date,
            task.position,
          );
          imported += 1;
        }
      }
    });

    tx();

    return { imported, skipped, total, boardSlug: targetBoard.slug };
  } finally {
    sourceDb.close();
  }
}
