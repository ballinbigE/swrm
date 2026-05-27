// scripts/pm/api/attempts.ts — US-VK-002 attempts CRUD.
//
// An "attempt" is a sandbox: a fresh git branch + worktree where an agent
// (claude-code, codex, gemini, manual) tries to deliver the task. Each
// task can have N attempts, all comparable side-by-side.
//
//   POST   /api/tasks/:id/attempts    spawn attempt (creates worktree + branch)
//   GET    /api/tasks/:id/attempts    list attempts for a task
//   PATCH  /api/attempts/:id          update status/summary/head_sha
//   DELETE /api/attempts/:id          remove worktree + branch + row
//
// Inspired by BloopAI/vibe-kanban's attempt model (`crates/worktree-manager`).

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import {
  addWorktree,
  branchForAttempt,
  diffStats,
  headSha,
  removeWorktree,
} from '../lib/worktree';
import { broadcast } from './workspace_stream';

export interface AttemptRow {
  id: number;
  task_id: number;
  attempt_number: number;
  branch_name: string;
  worktree_path: string;
  agent_name: string;
  status: 'running' | 'completed' | 'failed' | 'abandoned';
  summary: string | null;
  diff_stats: string | null;
  base_sha: string | null;
  head_sha: string | null;
  created_at: string;
  completed_at: string | null;
  repo_root: string;
}

/** Pick the right repo to operate against for this attempt. */
function repoRootFor(attempt: { repo_root?: string }, override?: string): string {
  if (override) return override;
  if (attempt.repo_root && attempt.repo_root.length > 0) return attempt.repo_root;
  return process.cwd();
}

export interface CreateAttemptInput {
  agent_name?: string;
  base_ref?: string;
  repo_root?: string;
  /**
   * When true, immediately fork the configured agent binary in the new
   * worktree after the DB insert. Default false — rep drives manually.
   * Subprocess streams stdout/stderr into chat_messages with task+attempt
   * scoping.
   */
  auto_run?: boolean;
  /** Prompt forwarded to the agent when auto_run is true. */
  prompt?: string;
}

export interface UpdateAttemptInput {
  status?: AttemptRow['status'];
  summary?: string;
  head_sha?: string;
  refresh_diff?: boolean;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function nextAttemptNumber(db: Database.Database, taskId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM attempts WHERE task_id = ?`)
    .get(taskId) as { n: number };
  return row.n;
}

export async function createAttempt(
  db: Database.Database,
  taskId: number,
  input: CreateAttemptInput = {},
): Promise<AttemptRow> {
  const task = db
    .prepare(`SELECT id FROM tasks WHERE id = ? AND archived_at IS NULL`)
    .get(taskId);
  if (!task) throw new HttpError(404, `task ${taskId} not found`);

  const agentName = (input.agent_name ?? 'claude-code').trim();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(agentName)) {
    throw new HttpError(400, `invalid agent_name: ${agentName}`);
  }

  const attemptNumber = nextAttemptNumber(db, taskId);
  const repoRoot = input.repo_root ?? process.cwd();

  const { branch, worktreePath, baseSha } = await addWorktree(taskId, attemptNumber, {
    repoRoot,
    baseRef: input.base_ref ?? 'main',
  });

  // Transactional bookkeeping: if the INSERT fails after addWorktree
  // succeeded, roll back the filesystem side-effect so we don't leak
  // an orphan worktree on disk with no DB row.
  try {
    const r = db
      .prepare(
        `INSERT INTO attempts
           (task_id, attempt_number, branch_name, worktree_path, agent_name, status, base_sha, head_sha, repo_root)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(taskId, attemptNumber, branch, worktreePath, agentName, baseSha, baseSha, repoRoot);

    const row = db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(r.lastInsertRowid as number) as AttemptRow;
    broadcast(taskId, 'attempt-created', { attempt: row });

    if (input.auto_run === true) {
      // Fire-and-forget; the subprocess updates attempts.status itself
      // when it exits. Caller does not await — POST returns immediately.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runAgentInWorktree } = require('../lib/agent_runner');
      runAgentInWorktree(db, row, { prompt: input.prompt ?? '' }).catch(() => {});
    }
    return row;
  } catch (dbErr) {
    await removeWorktree(worktreePath, { repoRoot, deleteBranch: branch }).catch(() => {});
    throw dbErr;
  }
}

export function listAttempts(db: Database.Database, taskId: number): AttemptRow[] {
  return db
    .prepare(`SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_number ASC`)
    .all(taskId) as AttemptRow[];
}

export function getAttempt(db: Database.Database, id: number): AttemptRow | null {
  return (db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id) as AttemptRow | undefined) ?? null;
}

export async function updateAttempt(
  db: Database.Database,
  id: number,
  patch: UpdateAttemptInput,
  opts: { repoRoot?: string } = {},
): Promise<AttemptRow> {
  const row = getAttempt(db, id);
  if (!row) throw new HttpError(404, `attempt ${id} not found`);

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.status !== undefined) {
    const validStatus: AttemptRow['status'][] = ['running', 'completed', 'failed', 'abandoned'];
    if (!validStatus.includes(patch.status)) {
      throw new HttpError(400, `invalid status: ${patch.status}`);
    }
    sets.push(`status = @status`);
    params.status = patch.status;
    if (patch.status !== 'running') {
      sets.push(`completed_at = datetime('now')`);
    }
  }
  if (patch.summary !== undefined) {
    sets.push(`summary = @summary`);
    params.summary = patch.summary;
  }
  if (patch.head_sha !== undefined) {
    if (!/^[a-f0-9]{4,40}$/i.test(patch.head_sha)) {
      throw new HttpError(400, `invalid head_sha: ${patch.head_sha}`);
    }
    sets.push(`head_sha = @head_sha`);
    params.head_sha = patch.head_sha;
  }

  // Optional: recompute diff_stats from the worktree's current HEAD vs base_sha.
  if (patch.refresh_diff) {
    const repoRoot = repoRootFor(row, opts.repoRoot);
    const head = await headSha(row.worktree_path);
    const stats = await diffStats(row.base_sha ?? head, head, { repoRoot });
    sets.push(`head_sha = @auto_head`, `diff_stats = @diff_stats`);
    params.auto_head = head;
    params.diff_stats = JSON.stringify(stats);
  }

  if (sets.length === 0) throw new HttpError(400, 'patch is empty');

  db.prepare(`UPDATE attempts SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const updated = getAttempt(db, id) as AttemptRow;
  broadcast(updated.task_id, 'attempt-updated', { attempt: updated });
  return updated;
}

export async function deleteAttempt(
  db: Database.Database,
  id: number,
  opts: { repoRoot?: string } = {},
): Promise<boolean> {
  const row = getAttempt(db, id);
  if (!row) return false;

  await removeWorktree(row.worktree_path, {
    repoRoot: repoRootFor(row, opts.repoRoot),
    deleteBranch: row.branch_name,
  });

  const r = db.prepare(`DELETE FROM attempts WHERE id = ?`).run(id);
  return r.changes > 0;
}

/**
 * Merge an attempt's branch into the target branch (default 'main') via
 * `git merge --no-ff`, mark the attempt as completed, then clean up the
 * worktree. Refuses to merge a 'failed' or 'abandoned' attempt.
 */
export async function mergeAttempt(
  db: Database.Database,
  id: number,
  opts: { repoRoot?: string; targetBranch?: string; message?: string } = {},
): Promise<{ ok: true; mergedSha: string } | { ok: false; reason: string }> {
  const row = getAttempt(db, id);
  if (!row) throw new HttpError(404, `attempt ${id} not found`);
  if (row.status === 'failed' || row.status === 'abandoned') {
    return { ok: false, reason: `attempt status is ${row.status}` };
  }

  const repoRoot = repoRootFor(row, opts.repoRoot);
  const target = opts.targetBranch ?? 'main';
  const message = opts.message ?? `merge attempt #${row.attempt_number} (${row.branch_name})`;
  // execFile not exec: cmd + args array. CommonJS require so jest+babel
  // don't choke on dynamic ESM import().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('node:child_process') as typeof import('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const utilMod = require('node:util') as typeof import('node:util');
  const run = utilMod.promisify(cp.execFile);

  try {
    await run('git', ['checkout', target], { cwd: repoRoot });
    await run('git', ['merge', '--no-ff', '-m', message, row.branch_name], { cwd: repoRoot });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const { stdout: shaOut } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const mergedSha = shaOut.trim();

  await removeWorktree(row.worktree_path, { repoRoot, deleteBranch: row.branch_name }).catch(() => {});
  db.prepare(
    `UPDATE attempts SET status = 'completed', completed_at = datetime('now'), head_sha = ? WHERE id = ?`,
  ).run(mergedSha, id);

  return { ok: true, mergedSha };
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

const TASK_ATTEMPTS_RE = /^\/api\/tasks\/(\d+)\/attempts\/?$/;
const ATTEMPT_BY_ID_RE = /^\/api\/attempts\/(\d+)\/?$/;
const ATTEMPT_MERGE_RE = /^\/api\/attempts\/(\d+)\/merge\/?$/;

export async function attemptsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  const taskMatch = url.match(TASK_ATTEMPTS_RE);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (method === 'GET') {
      sendJson(res, 200, { attempts: listAttempts(db, taskId) });
      return true;
    }
    if (method === 'POST') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        return true;
      }
      try {
        const attempt = await createAttempt(db, taskId, body as CreateAttemptInput);
        sendJson(res, 201, { attempt });
      } catch (err) {
        const e = err as HttpError;
        sendJson(res, e.status ?? 500, { error: e.message });
      }
      return true;
    }
    sendJson(res, 405, { error: `method ${method} not allowed on ${url}` });
    return true;
  }

  const mergeMatch = url.match(ATTEMPT_MERGE_RE);
  if (mergeMatch && method === 'POST') {
    const mid = Number(mergeMatch[1]);
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      return true;
    }
    try {
      const opts = body as { message?: string; target_branch?: string };
      const result = await mergeAttempt(db, mid, {
        message: opts.message,
        targetBranch: opts.target_branch,
      });
      sendJson(res, result.ok ? 200 : 409, result);
    } catch (err) {
      const e = err as HttpError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  const byIdMatch = url.match(ATTEMPT_BY_ID_RE);
  if (!byIdMatch) return false;
  const id = Number(byIdMatch[1]);
  if (!Number.isFinite(id) || id <= 0) {
    sendJson(res, 400, { error: 'invalid attempt id' });
    return true;
  }

  if (method === 'GET') {
    const row = getAttempt(db, id);
    if (!row) {
      sendJson(res, 404, { error: `attempt ${id} not found` });
      return true;
    }
    sendJson(res, 200, { attempt: row });
    return true;
  }

  if (method === 'PATCH') {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
      return true;
    }
    try {
      const updated = await updateAttempt(db, id, body as UpdateAttemptInput);
      sendJson(res, 200, { attempt: updated });
    } catch (err) {
      const e = err as HttpError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  if (method === 'DELETE') {
    try {
      const ok = await deleteAttempt(db, id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: `attempt ${id} not found` });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}

export { branchForAttempt };
