// scripts/pm/api/labels.ts — labels + task-label join API.
// Per US-008 of tasks/prd-personal-ai-pm-system.md.
//
//   POST   /api/labels                          create a label (global or scoped)
//   GET    /api/labels                          list labels (?board_id=<n> filter)
//   POST   /api/tasks/:tid/labels               attach: body {label_id} or {name}
//   DELETE /api/tasks/:tid/labels/:lid          detach
//
// Label attachments already render in listTasksForBoard (US-004), so no
// reader changes are needed here.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

export interface LabelRow {
  id: number;
  name: string;
  color: string;
  board_id: number | null;
  created_at: string;
}

export interface CreateLabelInput {
  name: string;
  color?: string;
  board_id?: number | null;
}

export function createLabel(db: Database.Database, input: CreateLabelInput): LabelRow {
  if (!input.name || typeof input.name !== 'string' || input.name.trim() === '') {
    const err = new Error('name is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  if (input.board_id != null) {
    const exists = db.prepare(`SELECT 1 FROM boards WHERE id = ?`).get(input.board_id);
    if (!exists) {
      const err = new Error(`board ${input.board_id} not found`);
      (err as Error & { code?: string }).code = 'VALIDATION';
      throw err;
    }
  }

  // SQLite NULL ≠ NULL caveat: rely on app-level dedupe for global labels
  // (board_id IS NULL) — same approach as seed.ts.
  const dupe = db.prepare(
    input.board_id == null
      ? `SELECT id FROM labels WHERE name = ? AND board_id IS NULL`
      : `SELECT id FROM labels WHERE name = ? AND board_id = ?`,
  );
  const existing = input.board_id == null
    ? dupe.get(input.name.trim())
    : dupe.get(input.name.trim(), input.board_id);
  if (existing) {
    const err = new Error(`label "${input.name.trim()}" already exists${input.board_id ? ` on board ${input.board_id}` : ' (global)'}`);
    (err as Error & { code?: string }).code = 'CONFLICT';
    throw err;
  }

  const r = db
    .prepare(
      `INSERT INTO labels (name, color, board_id) VALUES (?, ?, ?)`,
    )
    .run(input.name.trim(), input.color ?? '#34d399', input.board_id ?? null);

  return db.prepare(`SELECT * FROM labels WHERE id = ?`).get(r.lastInsertRowid as number) as LabelRow;
}

export function listLabels(db: Database.Database, boardId?: number | null): LabelRow[] {
  if (boardId === undefined) {
    return db.prepare(`SELECT * FROM labels ORDER BY board_id, name`).all() as LabelRow[];
  }
  if (boardId === null) {
    return db.prepare(`SELECT * FROM labels WHERE board_id IS NULL ORDER BY name`).all() as LabelRow[];
  }
  // include both board-scoped + global so the picker shows both
  return db
    .prepare(`SELECT * FROM labels WHERE board_id = ? OR board_id IS NULL ORDER BY board_id, name`)
    .all(boardId) as LabelRow[];
}

export interface AttachLabelInput {
  label_id?: number;
  name?: string; // alternative: attach-by-name (auto-creates global if missing)
}

export function attachLabel(
  db: Database.Database,
  taskId: number,
  input: AttachLabelInput,
): { task_id: number; label_id: number; created_label: boolean } {
  const taskExists = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND archived_at IS NULL`).get(taskId);
  if (!taskExists) {
    const err = new Error(`task ${taskId} not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  let labelId = input.label_id;
  let createdLabel = false;
  if (!labelId && input.name) {
    const existing = db
      .prepare(`SELECT id FROM labels WHERE name = ? AND board_id IS NULL`)
      .get(input.name.trim()) as { id: number } | undefined;
    if (existing) {
      labelId = existing.id;
    } else {
      const l = createLabel(db, { name: input.name });
      labelId = l.id;
      createdLabel = true;
    }
  }
  if (!labelId) {
    const err = new Error('label_id or name is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }

  const labelExists = db.prepare(`SELECT 1 FROM labels WHERE id = ?`).get(labelId);
  if (!labelExists) {
    const err = new Error(`label ${labelId} not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  // INSERT OR IGNORE — re-attaching is a no-op, not an error.
  db.prepare(`INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)`).run(taskId, labelId);

  return { task_id: taskId, label_id: labelId, created_label: createdLabel };
}

export function detachLabel(db: Database.Database, taskId: number, labelId: number): boolean {
  const r = db.prepare(`DELETE FROM task_labels WHERE task_id = ? AND label_id = ?`).run(taskId, labelId);
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

const TASK_LABELS_RE = /^\/api\/tasks\/(\d+)\/labels\/?$/;
const TASK_LABEL_DETACH_RE = /^\/api\/tasks\/(\d+)\/labels\/(\d+)\/?$/;

export async function labelsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // /api/labels (POST + GET)
  if ((url === '/api/labels' || url.startsWith('/api/labels?')) && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') {
      try {
        const qIndex = url.indexOf('?');
        const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
        const rawBoard = params.get('board_id');
        const boardId = rawBoard === null ? undefined : rawBoard === '' ? null : Number(rawBoard);
        sendJson(res, 200, { labels: listLabels(db, boardId as number | null | undefined) });
      } catch (err: any) {
        sendJson(res, 500, { error: err?.message ?? String(err) });
      }
      return true;
    }
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const label = createLabel(db, body as CreateLabelInput);
      sendJson(res, 201, { label });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code;
      const status = code === 'VALIDATION' ? 400 : code === 'CONFLICT' ? 409 : 500;
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
    return true;
  }

  // DETACH first: /api/tasks/:tid/labels/:lid
  const detachMatch = url.match(TASK_LABEL_DETACH_RE);
  if (method === 'DELETE' && detachMatch) {
    const taskId = Number(detachMatch[1]);
    const labelId = Number(detachMatch[2]);
    try {
      const ok = detachLabel(db, taskId, labelId);
      if (!ok) {
        sendJson(res, 404, { error: `label ${labelId} not attached to task ${taskId}` });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
    return true;
  }

  // ATTACH: /api/tasks/:tid/labels
  const attachMatch = url.match(TASK_LABELS_RE);
  if (method === 'POST' && attachMatch) {
    const taskId = Number(attachMatch[1]);
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const result = attachLabel(db, taskId, body as AttachLabelInput);
      sendJson(res, 201, result);
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code;
      const status = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' ? 400 : 500;
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
    return true;
  }

  return false;
}
