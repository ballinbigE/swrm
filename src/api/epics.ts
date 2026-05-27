// scripts/pm/api/epics.ts — Epics CRUD.
// Per US-006 of tasks/prd-personal-ai-pm-system.md.
//
//   POST   /api/epics          create
//   GET    /api/epics          list w/ {open, done} child task counts
//   PATCH  /api/epics/:id      update any subset of fields
//   DELETE /api/epics/:id      delete; child tasks survive (epic_id → NULL via FK ON DELETE SET NULL)
//
// Pure functions accept Database directly so tests don't need an http server.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

const ALLOWED_STATUSES = ['open', 'done', 'archived'] as const;
type EpicStatus = (typeof ALLOWED_STATUSES)[number];

export interface CreateEpicInput {
  title: string;
  board_id: number;
  description?: string | null;
  color?: string | null;
  status?: EpicStatus;
  target_date?: string | null;
  position?: number;
}

export interface EpicRow {
  id: number;
  board_id: number;
  title: string;
  description: string | null;
  color: string;
  status: string;
  target_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface EpicWithCounts extends EpicRow {
  open_count: number;
  done_count: number;
  total_count: number;
}

export function createEpic(db: Database.Database, input: CreateEpicInput): EpicRow {
  if (!input.title || typeof input.title !== 'string' || input.title.trim() === '') {
    const err = new Error('title is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  if (!input.board_id || typeof input.board_id !== 'number') {
    const err = new Error('board_id is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  if (input.status && !(ALLOWED_STATUSES as readonly string[]).includes(input.status)) {
    const err = new Error(`invalid status: ${input.status}`);
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  const boardExists = db.prepare(`SELECT 1 FROM boards WHERE id = ?`).get(input.board_id);
  if (!boardExists) {
    const err = new Error(`board ${input.board_id} not found`);
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }

  const stmt = db.prepare(
    `INSERT INTO epics (board_id, title, description, color, status, target_date, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const r = stmt.run(
    input.board_id,
    input.title.trim(),
    input.description ?? null,
    input.color ?? '#f6c545',
    input.status ?? 'open',
    input.target_date ?? null,
    input.position ?? 0,
  );
  const id = r.lastInsertRowid as number;
  return db.prepare(`SELECT * FROM epics WHERE id = ?`).get(id) as EpicRow;
}

export function listEpicsWithCounts(db: Database.Database, boardId?: number): EpicWithCounts[] {
  const sql = boardId
    ? `SELECT * FROM epics WHERE board_id = ? ORDER BY position, id`
    : `SELECT * FROM epics ORDER BY board_id, position, id`;
  const epics = (boardId
    ? db.prepare(sql).all(boardId)
    : db.prepare(sql).all()) as EpicRow[];

  if (epics.length === 0) return [];

  const epicIds = epics.map((e) => e.id);
  const placeholders = epicIds.map(() => '?').join(',');
  const countRows = db
    .prepare(
      `SELECT epic_id,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
              SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open_count,
              COUNT(*) AS total_count
       FROM tasks
       WHERE epic_id IN (${placeholders}) AND archived_at IS NULL
       GROUP BY epic_id`,
    )
    .all(...epicIds) as Array<{ epic_id: number; open_count: number; done_count: number; total_count: number }>;

  const countByEpic = new Map(countRows.map((r) => [r.epic_id, r]));

  return epics.map((e) => {
    const c = countByEpic.get(e.id);
    return {
      ...e,
      open_count: Number(c?.open_count ?? 0),
      done_count: Number(c?.done_count ?? 0),
      total_count: Number(c?.total_count ?? 0),
    };
  });
}

export type EpicUpdatableField = 'title' | 'description' | 'color' | 'status' | 'target_date' | 'position' | 'board_id';

const EPIC_UPDATABLE: ReadonlySet<EpicUpdatableField> = new Set([
  'title', 'description', 'color', 'status', 'target_date', 'position', 'board_id',
]);

export function updateEpic(
  db: Database.Database,
  id: number,
  patch: Partial<Record<EpicUpdatableField, unknown>>,
): boolean {
  const exists = db.prepare(`SELECT 1 FROM epics WHERE id = ?`).get(id);
  if (!exists) return false;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!EPIC_UPDATABLE.has(k as EpicUpdatableField)) continue;
    if (k === 'status' && v != null && !(ALLOWED_STATUSES as readonly string[]).includes(String(v))) {
      const err = new Error(`invalid status: ${v}`);
      (err as Error & { code?: string }).code = 'VALIDATION';
      throw err;
    }
    setClauses.push(`${k} = ?`);
    values.push(v);
  }
  if (setClauses.length === 0) return true;
  setClauses.push(`updated_at = datetime('now')`);
  const stmt = db.prepare(`UPDATE epics SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values, id);
  return true;
}

// Hard-delete the epic; FK ON DELETE SET NULL leaves child tasks intact with
// epic_id = NULL. Per PRD: tasks survive epic deletion.
export function deleteEpic(db: Database.Database, id: number): boolean {
  const r = db.prepare(`DELETE FROM epics WHERE id = ?`).run(id);
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

const EPIC_BY_ID_RE = /^\/api\/epics\/(\d+)\/?$/;

export async function epicsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && (url === '/api/epics' || url.startsWith('/api/epics?'))) {
    try {
      const qIndex = url.indexOf('?');
      const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
      const boardId = params.get('board_id') ? Number(params.get('board_id')) : undefined;
      sendJson(res, 200, { epics: listEpicsWithCounts(db, boardId) });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
    return true;
  }

  if (method === 'POST' && (url === '/api/epics' || url === '/api/epics/')) {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON body: ${err?.message ?? err}` });
      return true;
    }
    try {
      const epic = createEpic(db, body as CreateEpicInput);
      sendJson(res, 201, { epic });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code === 'VALIDATION' ? 400 : 500;
      sendJson(res, code, { error: err?.message ?? String(err) });
    }
    return true;
  }

  const m = url.match(EPIC_BY_ID_RE);
  if (!m) return false;
  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) {
    sendJson(res, 400, { error: 'invalid epic id' });
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
      const ok = updateEpic(db, id, (body ?? {}) as Partial<Record<EpicUpdatableField, unknown>>);
      if (!ok) {
        sendJson(res, 404, { error: `epic ${id} not found` });
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
      const ok = deleteEpic(db, id);
      if (!ok) {
        sendJson(res, 404, { error: `epic ${id} not found` });
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
