// swrm/src/api/board_prefs.ts — per-board preferences.
//   PATCH /api/boards/:id/prefs   body: { color?, name?, workflow? }
//
// Minimal, deliberately: a board gets a color (kanban accent) and a
// workflow (ordered list of status-column keys). No per-status colors,
// no WIP limits, no transition rules — just the column set + order +
// one accent color. Keep it boring.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

// Status keys allowed in a workflow. Constrained so a typo can't create
// an un-routable column + so task.status values stay a known set.
export const ALLOWED_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked', 'shipped'] as const;
export type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface BoardPrefsPatch {
  color?: string;
  name?: string;
  workflow?: string[];
}

export class PrefsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function updateBoardPrefs(db: Database.Database, boardId: number, patch: BoardPrefsPatch): {
  id: number;
  slug: string;
  name: string;
  color: string;
  workflow: string[];
} {
  const board = db.prepare(`SELECT id FROM boards WHERE id = ?`).get(boardId);
  if (!board) throw new PrefsError(404, `board ${boardId} not found`);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: boardId };

  if (patch.color !== undefined) {
    if (!HEX_RE.test(patch.color)) throw new PrefsError(400, `invalid color (need #rrggbb): ${patch.color}`);
    sets.push(`color = @color`);
    params.color = patch.color;
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) throw new PrefsError(400, 'name cannot be empty');
    if (name.length > 60) throw new PrefsError(400, 'name too long (max 60)');
    sets.push(`name = @name`);
    params.name = name;
  }
  if (patch.workflow !== undefined) {
    if (!Array.isArray(patch.workflow) || patch.workflow.length === 0) {
      throw new PrefsError(400, 'workflow must be a non-empty array of status keys');
    }
    const seen = new Set<string>();
    for (const s of patch.workflow) {
      if (!(ALLOWED_STATUSES as readonly string[]).includes(s)) {
        throw new PrefsError(400, `unknown status '${s}' (allowed: ${ALLOWED_STATUSES.join(', ')})`);
      }
      if (seen.has(s)) throw new PrefsError(400, `duplicate status '${s}' in workflow`);
      seen.add(s);
    }
    sets.push(`workflow = @workflow`);
    params.workflow = JSON.stringify(patch.workflow);
  }

  if (sets.length === 0) throw new PrefsError(400, 'patch is empty');
  sets.push(`updated_at = datetime('now')`);

  db.prepare(`UPDATE boards SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getBoardPrefs(db, boardId);
}

export function getBoardPrefs(db: Database.Database, boardId: number): {
  id: number;
  slug: string;
  name: string;
  color: string;
  workflow: string[];
} {
  const row = db
    .prepare(`SELECT id, slug, name, color, workflow FROM boards WHERE id = ?`)
    .get(boardId) as { id: number; slug: string; name: string; color: string; workflow: string } | undefined;
  if (!row) throw new PrefsError(404, `board ${boardId} not found`);
  return { id: row.id, slug: row.slug, name: row.name, color: row.color, workflow: parseWorkflow(row.workflow) };
}

/** Parse the stored workflow JSON, falling back to the default five on any corruption. */
export function parseWorkflow(raw: string | null | undefined): string[] {
  if (!raw) return ['backlog', 'todo', 'in_progress', 'review', 'done'];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === 'string')) return arr;
  } catch {
    /* fall through */
  }
  return ['backlog', 'todo', 'in_progress', 'review', 'done'];
}

// ── http ────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, maxBytes = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PREFS_RE = /^\/api\/boards\/(\d+)\/prefs\/?$/;

export async function boardPrefsHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0];
  const m = url.match(PREFS_RE);
  if (!m) return false;
  if ((req.method ?? 'GET') !== 'PATCH') {
    sendJson(res, 405, { error: `method ${req.method} not allowed` });
    return true;
  }
  const id = Number(m[1]);
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return true;
  }
  try {
    const updated = updateBoardPrefs(db, id, body as BoardPrefsPatch);
    sendJson(res, 200, { board: updated });
  } catch (err) {
    const e = err as PrefsError;
    sendJson(res, e.status ?? 500, { error: e.message });
  }
  return true;
}
