// scripts/pm/api/tasks.ts — write endpoints for tasks (POST / PATCH / DELETE).
// Per US-005 of tasks/prd-personal-ai-pm-system.md.
//
//   POST   /api/tasks            create
//   PATCH  /api/tasks/:id        update any subset of fields
//   DELETE /api/tasks/:id        soft-delete (sets archived_at); does NOT cascade subtasks

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { mirrorClosure } from '../shipped_mirror';

const ALLOWED_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'] as const;

export interface CreateTaskInput {
  title: string;
  board_id?: number;
  status?: string;
  priority?: string | null;
  effort_hours?: number | null;
  due_date?: string | null;
  epic_id?: number | null;
  description?: string | null;
  blockers?: string | null;
  position?: number;
}

export interface CreatedTask {
  id: number;
  board_id: number;
  title: string;
  status: string;
  priority: string | null;
  effort_hours: number | null;
  due_date: string | null;
  epic_id: number | null;
}

// Default board: 'personal' if no board_id supplied.
function defaultBoardId(db: Database.Database): number {
  const row = db.prepare(`SELECT id FROM boards WHERE slug = 'personal' LIMIT 1`).get() as { id: number } | undefined;
  if (row) return row.id;
  const any = db.prepare(`SELECT id FROM boards ORDER BY position, id LIMIT 1`).get() as { id: number } | undefined;
  if (!any) throw new Error('no boards exist — run npm run pm:seed');
  return any.id;
}

export function createTask(db: Database.Database, input: CreateTaskInput): CreatedTask {
  if (!input.title || typeof input.title !== 'string' || input.title.trim() === '') {
    const err = new Error('title is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  const boardId = input.board_id ?? defaultBoardId(db);
  const status = input.status ?? 'backlog';
  if (!(ALLOWED_STATUSES as readonly string[]).includes(status)) {
    const err = new Error(`invalid status: ${status}`);
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  if (input.priority != null && !(ALLOWED_PRIORITIES as readonly string[]).includes(input.priority)) {
    const err = new Error(`invalid priority: ${input.priority}`);
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }

  const stmt = db.prepare(
    `INSERT INTO tasks
       (board_id, title, status, priority, effort_hours, due_date, epic_id, description, blockers, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    boardId,
    input.title.trim(),
    status,
    input.priority ?? null,
    input.effort_hours ?? null,
    input.due_date ?? null,
    input.epic_id ?? null,
    input.description ?? null,
    input.blockers ?? null,
    input.position ?? 0,
  );

  const id = result.lastInsertRowid as number;
  return {
    id,
    board_id: boardId,
    title: input.title.trim(),
    status,
    priority: input.priority ?? null,
    effort_hours: input.effort_hours ?? null,
    due_date: input.due_date ?? null,
    epic_id: input.epic_id ?? null,
  };
}

export type UpdatableField =
  | 'title' | 'description' | 'status' | 'priority' | 'effort_hours'
  | 'due_date' | 'blockers' | 'epic_id' | 'position' | 'board_id';

const UPDATABLE: ReadonlySet<UpdatableField> = new Set([
  'title', 'description', 'status', 'priority', 'effort_hours',
  'due_date', 'blockers', 'epic_id', 'position', 'board_id',
]);

export function updateTask(
  db: Database.Database,
  id: number,
  patch: Partial<Record<UpdatableField, unknown>>,
): boolean {
  const before = db
    .prepare(`SELECT status FROM tasks WHERE id = ? AND archived_at IS NULL`)
    .get(id) as { status: string } | undefined;
  if (!before) return false;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE.has(k as UpdatableField)) continue;
    if (k === 'status' && v != null && !(ALLOWED_STATUSES as readonly string[]).includes(String(v))) {
      const err = new Error(`invalid status: ${v}`);
      (err as Error & { code?: string }).code = 'VALIDATION';
      throw err;
    }
    if (k === 'priority' && v != null && !(ALLOWED_PRIORITIES as readonly string[]).includes(String(v))) {
      const err = new Error(`invalid priority: ${v}`);
      (err as Error & { code?: string }).code = 'VALIDATION';
      throw err;
    }
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
  if (setClauses.length === 0) return true; // nothing to update — no-op
  setClauses.push(`updated_at = datetime('now')`);

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values, id);

  // Mirror to tasks/shipped.md when status transitions INTO 'done'. The
  // mirror is a no-op unless PM_SHIPPED_MD_PATH is set (server.ts main()
  // wires this; tests + the CLI skip it). Failure here must not roll back
  // the DB write — wrap in try.
  if (patch.status === 'done' && before.status !== 'done') {
    try { mirrorClosure(db, id, 'status_done'); } catch { /* mirror is best-effort */ }
  }
  return true;
}

export function archiveTask(db: Database.Database, id: number): boolean {
  const stmt = db.prepare(
    `UPDATE tasks SET archived_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND archived_at IS NULL`,
  );
  const r = stmt.run(id);
  if (r.changes > 0) {
    try { mirrorClosure(db, id, 'archived'); } catch { /* mirror is best-effort */ }
  }
  return r.changes > 0;
}

// ── http handler ──────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const TASK_BY_ID_RE = /^\/api\/tasks\/(\d+)\/?$/;

export async function tasksApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'POST' && (url === '/api/tasks' || url === '/api/tasks/')) {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const created = createTask(db, body as CreateTaskInput);
      sendJson(res, 201, { task: created });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code === 'VALIDATION' ? 400 : 500;
      sendJson(res, code, { error: err?.message ?? String(err) });
    }
    return true;
  }

  const m = url.match(TASK_BY_ID_RE);
  if (!m) return false;
  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) {
    sendJson(res, 400, { error: 'invalid task id' });
    return true;
  }

  if (method === 'PATCH') {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const ok = updateTask(db, id, (body ?? {}) as Partial<Record<UpdatableField, unknown>>);
      if (!ok) {
        sendJson(res, 404, { error: `task ${id} not found` });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code === 'VALIDATION' ? 400 : 500;
      sendJson(res, code, { error: err?.message ?? String(err) });
    }
    return true;
  }

  if (method === 'DELETE') {
    try {
      const ok = archiveTask(db, id);
      if (!ok) {
        sendJson(res, 404, { error: `task ${id} not found` });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
    return true;
  }

  return false;
}
