// scripts/pm/api/attempt_comments.ts — US-VK-005 inline diff comments.
//
//   POST   /api/attempts/:id/comments      create
//   GET    /api/attempts/:id/comments      list (newest first)
//   PATCH  /api/comments/:id               resolve / edit body
//   DELETE /api/comments/:id               remove
//   POST   /api/attempts/:id/reprompt      bundle open comments into one
//                                          chat_messages row (re-prompt
//                                          loop primitive — the rep then
//                                          copies that into Claude Code).
//
// Comments fan-out: every comment write also inserts a `chat_messages`
// row with role='user' so the conversation pane in /workspace/:id shows
// the running feedback log.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { getAttempt } from './attempts';
import { broadcast } from './workspace_stream';

export interface CommentRow {
  id: number;
  attempt_id: number;
  file_path: string | null;
  line_number: number | null;
  diff_line: string | null;
  body: string;
  resolved: number;
  created_at: string;
  resolved_at: string | null;
}

export interface CreateCommentInput {
  body: string;
  file_path?: string | null;
  line_number?: number | null;
  diff_line?: string | null;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function createComment(
  db: Database.Database,
  attemptId: number,
  input: CreateCommentInput,
): CommentRow {
  const attempt = getAttempt(db, attemptId);
  if (!attempt) throw new HttpError(404, `attempt ${attemptId} not found`);
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new HttpError(400, 'body (non-empty string) is required');
  }

  const filePath = input.file_path && typeof input.file_path === 'string' ? input.file_path : null;
  const lineNumber = typeof input.line_number === 'number' && input.line_number > 0 ? input.line_number : null;
  const diffLine = typeof input.diff_line === 'string' ? input.diff_line : null;

  const r = db
    .prepare(
      `INSERT INTO attempt_comments (attempt_id, file_path, line_number, diff_line, body)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(attemptId, filePath, lineNumber, diffLine, input.body.trim());

  // Fan-out to chat_messages so the conversation pane shows the comment
  // alongside any agent transcript. Scoped to the task + attempt so
  // comments don't bleed across workspaces.
  const where = filePath ? `${filePath}${lineNumber ? `:${lineNumber}` : ''}` : 'file-level';
  db.prepare(
    `INSERT INTO chat_messages (role, content, task_id, attempt_id) VALUES ('user', ?, ?, ?)`,
  ).run(
    `[attempt #${attempt.attempt_number} · ${where}] ${input.body.trim()}`,
    attempt.task_id,
    attempt.id,
  );

  const row = db.prepare(`SELECT * FROM attempt_comments WHERE id = ?`).get(r.lastInsertRowid as number) as CommentRow;
  broadcast(attempt.task_id, 'comment-added', { attempt_id: attemptId, comment: row });

  // Also surface the fanned-out chat_messages row to the live log pane.
  const lastChat = db
    .prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE task_id = ? AND attempt_id = ? ORDER BY id DESC LIMIT 1`)
    .get(attempt.task_id, attempt.id) as { id: number; role: string; content: string; created_at: string } | undefined;
  if (lastChat) {
    broadcast(attempt.task_id, 'chat-message-appended', { attempt_id: attempt.id, message: lastChat });
  }

  return row;
}

export function listComments(db: Database.Database, attemptId: number): CommentRow[] {
  return db
    .prepare(`SELECT * FROM attempt_comments WHERE attempt_id = ? ORDER BY created_at DESC, id DESC`)
    .all(attemptId) as CommentRow[];
}

export function getComment(db: Database.Database, id: number): CommentRow | null {
  return (db.prepare(`SELECT * FROM attempt_comments WHERE id = ?`).get(id) as CommentRow | undefined) ?? null;
}

export function updateComment(
  db: Database.Database,
  id: number,
  patch: { body?: string; resolved?: boolean },
): CommentRow {
  const row = getComment(db, id);
  if (!row) throw new HttpError(404, `comment ${id} not found`);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (typeof patch.body === 'string') {
    if (patch.body.trim().length === 0) throw new HttpError(400, 'body cannot be empty');
    sets.push(`body = @body`);
    params.body = patch.body.trim();
  }
  if (typeof patch.resolved === 'boolean') {
    sets.push(`resolved = @resolved`);
    params.resolved = patch.resolved ? 1 : 0;
    if (patch.resolved) sets.push(`resolved_at = datetime('now')`);
    else sets.push(`resolved_at = NULL`);
  }
  if (sets.length === 0) throw new HttpError(400, 'patch is empty');

  db.prepare(`UPDATE attempt_comments SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const updated = getComment(db, id) as CommentRow;
  const attempt = getAttempt(db, updated.attempt_id);
  if (attempt) broadcast(attempt.task_id, 'comment-updated', { comment: updated });
  return updated;
}

export function deleteComment(db: Database.Database, id: number): boolean {
  const before = getComment(db, id);
  const r = db.prepare(`DELETE FROM attempt_comments WHERE id = ?`).run(id);
  if (r.changes > 0 && before) {
    const attempt = getAttempt(db, before.attempt_id);
    if (attempt) broadcast(attempt.task_id, 'comment-deleted', { comment_id: id, attempt_id: before.attempt_id });
  }
  return r.changes > 0;
}

/**
 * Bundle all open (unresolved) comments on an attempt into a single
 * formatted re-prompt body, insert into chat_messages, and return it.
 * The rep then pastes this into Claude Code (manual loop for now).
 */
export function bundleReprompt(db: Database.Database, attemptId: number): { prompt: string; comment_ids: number[] } {
  const attempt = getAttempt(db, attemptId);
  if (!attempt) throw new HttpError(404, `attempt ${attemptId} not found`);

  const open = db
    .prepare(
      `SELECT * FROM attempt_comments WHERE attempt_id = ? AND resolved = 0 ORDER BY created_at ASC`,
    )
    .all(attemptId) as CommentRow[];

  if (open.length === 0) return { prompt: '', comment_ids: [] };

  const lines: string[] = [
    `Feedback on attempt #${attempt.attempt_number} (branch ${attempt.branch_name}):`,
    '',
  ];
  for (const c of open) {
    const where = c.file_path ? `${c.file_path}${c.line_number ? `:${c.line_number}` : ''}` : 'file-level';
    lines.push(`- ${where} — ${c.body}`);
    if (c.diff_line) lines.push(`    \`${c.diff_line.trim()}\``);
  }
  lines.push('');
  lines.push('Apply these and push.');
  const prompt = lines.join('\n');

  db.prepare(
    `INSERT INTO chat_messages (role, content, task_id, attempt_id) VALUES ('system', ?, ?, ?)`,
  ).run(prompt, attempt.task_id, attempt.id);
  return { prompt, comment_ids: open.map((c) => c.id) };
}

// ── http handler ──────────────────────────────────────────────────────────

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

const ATTEMPT_COMMENTS_RE = /^\/api\/attempts\/(\d+)\/comments\/?$/;
const ATTEMPT_REPROMPT_RE = /^\/api\/attempts\/(\d+)\/reprompt\/?$/;
const COMMENT_BY_ID_RE = /^\/api\/comments\/(\d+)\/?$/;

export async function attemptCommentsHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  const repromptMatch = url.match(ATTEMPT_REPROMPT_RE);
  if (repromptMatch && method === 'POST') {
    const attemptId = Number(repromptMatch[1]);
    try {
      const result = bundleReprompt(db, attemptId);
      sendJson(res, 200, result);
    } catch (err) {
      const e = err as HttpError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  const commentsMatch = url.match(ATTEMPT_COMMENTS_RE);
  if (commentsMatch) {
    const attemptId = Number(commentsMatch[1]);
    if (method === 'GET') {
      sendJson(res, 200, { comments: listComments(db, attemptId) });
      return true;
    }
    if (method === 'POST') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
        return true;
      }
      try {
        const comment = createComment(db, attemptId, body as CreateCommentInput);
        sendJson(res, 201, { comment });
      } catch (err) {
        const e = err as HttpError;
        sendJson(res, e.status ?? 500, { error: e.message });
      }
      return true;
    }
    sendJson(res, 405, { error: `method ${method} not allowed` });
    return true;
  }

  const byIdMatch = url.match(COMMENT_BY_ID_RE);
  if (!byIdMatch) return false;
  const id = Number(byIdMatch[1]);

  if (method === 'PATCH') {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      return true;
    }
    try {
      const updated = updateComment(db, id, body as { body?: string; resolved?: boolean });
      sendJson(res, 200, { comment: updated });
    } catch (err) {
      const e = err as HttpError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  if (method === 'DELETE') {
    const ok = deleteComment(db, id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: `comment ${id} not found` });
    return true;
  }

  return false;
}
