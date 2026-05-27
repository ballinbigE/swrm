// scripts/pm/api/attachments.ts — local file attachments for tasks.
// Per US-009 of tasks/prd-personal-ai-pm-system.md.
//
//   POST   /api/tasks/:id/attachments?filename=X&mime=Y   raw binary body
//   GET    /api/attachments/:id/file                       serve file w/ correct mime
//   DELETE /api/attachments/:id                            remove row + unlink file
//
// 25 MB cap enforced during stream read; reject larger with 413.
//
// Why query-param + raw body (instead of multipart/form-data):
// - Zero new deps (no busboy / formidable). Stdlib stream + fs only.
// - Browser side stays trivial: fetch(url + '?filename=' + encode(f.name) +
//   '&mime=' + encode(f.type), {method:'POST', body: f})
// - File objects send as raw bytes. The (US-016) detail panel will use
//   exactly this shape.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const ROOT = path.resolve(__dirname, '..', '..', '..');
export const ATTACHMENTS_DIR = path.join(ROOT, 'tasks', 'attachments');

export interface AttachmentRow {
  id: number;
  task_id: number;
  original_filename: string;
  stored_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

// Strip path separators + control chars. Keep extension visible for the rep.
function sanitizeFilename(raw: string): string {
  return String(raw)
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[/\\]/g, '_')
    .slice(0, 200);
}

function safeMime(raw: string): string {
  // Allow common /-separated tokens only.
  if (!raw || typeof raw !== 'string') return 'application/octet-stream';
  if (raw.length > 100) return 'application/octet-stream';
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;\s*[a-zA-Z0-9!#$&^_.+=-]+)*$/.test(raw)) {
    return 'application/octet-stream';
  }
  return raw;
}

export interface SaveAttachmentInput {
  task_id: number;
  filename: string;
  mime_type: string;
  bytes: Buffer;
}

export function saveAttachment(db: Database.Database, input: SaveAttachmentInput): AttachmentRow {
  if (!input.filename || input.filename.trim() === '') {
    const err = new Error('filename is required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  if (input.bytes.length > MAX_BYTES) {
    const err = new Error(`file exceeds ${MAX_BYTES} byte limit`);
    (err as Error & { code?: string }).code = 'TOO_LARGE';
    throw err;
  }
  const taskExists = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND archived_at IS NULL`).get(input.task_id);
  if (!taskExists) {
    const err = new Error(`task ${input.task_id} not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  const cleanName = sanitizeFilename(input.filename);
  const uid = crypto.randomUUID();
  const subdir = path.join(ATTACHMENTS_DIR, String(input.task_id));
  fs.mkdirSync(subdir, { recursive: true });
  const storedPath = path.join(subdir, `${uid}-${cleanName}`);
  fs.writeFileSync(storedPath, input.bytes);

  const r = db
    .prepare(
      `INSERT INTO attachments (task_id, original_filename, stored_path, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.task_id, cleanName, storedPath, safeMime(input.mime_type), input.bytes.length);

  return db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(r.lastInsertRowid as number) as AttachmentRow;
}

export function getAttachment(db: Database.Database, id: number): AttachmentRow | null {
  const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
  return row ?? null;
}

export function deleteAttachment(db: Database.Database, id: number): boolean {
  const row = getAttachment(db, id);
  if (!row) return false;
  // unlink file BEFORE row delete so a partial failure leaves a recoverable DB record.
  try {
    fs.unlinkSync(row.stored_path);
  } catch (err: any) {
    // ENOENT acceptable (already gone); rethrow other errors.
    if (err?.code !== 'ENOENT') throw err;
  }
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
  return true;
}

// ── http handler ──────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBodyBytes(req: http.IncomingMessage, maxBytes = MAX_BYTES): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const TASK_ATTACH_RE = /^\/api\/tasks\/(\d+)\/attachments\/?(?:\?.*)?$/;
const ATTACH_FILE_RE = /^\/api\/attachments\/(\d+)\/file\/?$/;
const ATTACH_BY_ID_RE = /^\/api\/attachments\/(\d+)\/?$/;

export async function attachmentsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // POST /api/tasks/:tid/attachments?filename=X&mime=Y
  const uploadMatch = url.match(TASK_ATTACH_RE);
  if (method === 'POST' && uploadMatch) {
    const taskId = Number(uploadMatch[1]);
    const qIndex = url.indexOf('?');
    const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
    const filename = params.get('filename') ?? '';
    const mime = params.get('mime') ?? req.headers['content-type'] ?? 'application/octet-stream';
    let bytes: Buffer;
    try {
      bytes = await readBodyBytes(req);
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code === 'TOO_LARGE' ? 413 : 400;
      sendJson(res, code, { error: err?.message ?? String(err) });
      return true;
    }
    try {
      const row = saveAttachment(db, { task_id: taskId, filename, mime_type: String(mime), bytes });
      sendJson(res, 201, { attachment: row });
    } catch (err: any) {
      const code = (err as Error & { code?: string }).code;
      const status = code === 'VALIDATION' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'TOO_LARGE' ? 413 : 500;
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
    return true;
  }

  // GET /api/attachments/:id/file
  const fileMatch = url.match(ATTACH_FILE_RE);
  if (method === 'GET' && fileMatch) {
    const id = Number(fileMatch[1]);
    const row = getAttachment(db, id);
    if (!row) {
      sendJson(res, 404, { error: `attachment ${id} not found` });
      return true;
    }
    try {
      const buf = fs.readFileSync(row.stored_path);
      res.writeHead(200, {
        'Content-Type': row.mime_type,
        'Content-Length': String(buf.length),
        'Content-Disposition': `inline; filename="${row.original_filename.replace(/"/g, '_')}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (err: any) {
      const code = err?.code === 'ENOENT' ? 410 : 500;
      sendJson(res, code, { error: `read failed: ${err?.message ?? err}` });
    }
    return true;
  }

  // DELETE /api/attachments/:id
  const byIdMatch = url.match(ATTACH_BY_ID_RE);
  if (method === 'DELETE' && byIdMatch) {
    const id = Number(byIdMatch[1]);
    try {
      const ok = deleteAttachment(db, id);
      if (!ok) {
        sendJson(res, 404, { error: `attachment ${id} not found` });
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
