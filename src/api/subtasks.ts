// scripts/pm/api/subtasks.ts — subtasks CRUD (one level under a task).
// Per US-007 of tasks/prd-personal-ai-pm-system.md.
//
//   POST   /api/tasks/:id/subtasks   create
//   PATCH  /api/subtasks/:id         toggle done / edit title
//   DELETE /api/subtasks/:id         remove
//
// No nesting: subtasks cannot themselves have subtasks. The schema's `subtasks`
// table has no parent_subtask_id and the API exposes no such endpoint.
// Aggregated subtask counts are already in listTasksForBoard (US-004).

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

export interface SubtaskRow {
  id: number;
  task_id: number;
  title: string;
  done: number;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSubtaskInput {
  title: string;
  position?: number;
  done?: boolean;
}

export function createSubtask(db: Database.Database, taskId: number, input: CreateSubtaskInput): SubtaskRow {
  if (!input.title || typeof input.title !== 'string' || input.title.trim() === '') {
    const err = new Error('title is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  const taskExists = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND archived_at IS NULL`).get(taskId);
  if (!taskExists) {
    const err = new Error(`task ${taskId} not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  // Default position = max existing + 1 (append at end).
  const maxRow = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM subtasks WHERE task_id = ?`).get(taskId) as { next: number };
  const position = input.position ?? maxRow.next;

  const r = db
    .prepare(
      `INSERT INTO subtasks (task_id, title, done, position) VALUES (?, ?, ?, ?)`,
    )
    .run(taskId, input.title.trim(), input.done ? 1 : 0, position);

  return db.prepare(`SELECT * FROM subtasks WHERE id = ?`).get(r.lastInsertRowid as number) as SubtaskRow;
}

export type SubtaskUpdatableField = 'title' | 'done' | 'position';

const SUB_UPDATABLE: ReadonlySet<SubtaskUpdatableField> = new Set(['title', 'done', 'position']);

export function updateSubtask(
  db: Database.Database,
  id: number,
  patch: Partial<{ title: string; done: boolean | number; position: number }>,
): boolean {
  const exists = db.prepare(`SELECT 1 FROM subtasks WHERE id = ?`).get(id);
  if (!exists) return false;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!SUB_UPDATABLE.has(k as SubtaskUpdatableField)) continue;
    if (k === 'done') {
      setClauses.push(`done = ?`);
      values.push(v ? 1 : 0);
    } else if (k === 'title') {
      if (typeof v !== 'string' || v.trim() === '') {
        const err = new Error('title cannot be empty');
        (err as Error & { code?: string }).code = 'VALIDATION';
        throw err;
      }
      setClauses.push(`title = ?`);
      values.push(v.trim());
    } else {
      setClauses.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (setClauses.length === 0) return true;
  setClauses.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE subtasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, id);
  return true;
}

export function deleteSubtask(db: Database.Database, id: number): boolean {
  const r = db.prepare(`DELETE FROM subtasks WHERE id = ?`).run(id);
  return r.changes > 0;
}

// ── http handler ──────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

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

const TASK_SUB_RE = /^\/api\/tasks\/(\d+)\/subtasks\/?$/;
const SUB_BY_ID_RE = /^\/api\/subtasks\/(\d+)\/?$/;

export async function subtasksApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  const createMatch = url.match(TASK_SUB_RE);
  if (method === 'POST' && createMatch) {
    const taskId = Number(createMatch[1]);
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const sub = createSubtask(db, taskId, body as CreateSubtaskInput);
      sendJson(res, 201, { subtask: sub });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code;
      const status = code === 'VALIDATION' ? 400 : code === 'NOT_FOUND' ? 404 : 500;
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
    return true;
  }

  const byIdMatch = url.match(SUB_BY_ID_RE);
  if (!byIdMatch) return false;
  const id = Number(byIdMatch[1]);
  if (!Number.isFinite(id) || id <= 0) {
    sendJson(res, 400, { error: 'invalid subtask id' });
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
      const ok = updateSubtask(db, id, body as Partial<{ title: string; done: boolean | number; position: number }>);
      if (!ok) {
        sendJson(res, 404, { error: `subtask ${id} not found` });
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
      const ok = deleteSubtask(db, id);
      if (!ok) {
        sendJson(res, 404, { error: `subtask ${id} not found` });
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
