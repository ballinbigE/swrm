// scripts/pm/api/diff.ts — GET /api/attempts/:id/diff
//
// Returns the unified diff (`git diff baseSha..headSha`) for an attempt's
// worktree as text/plain. Empty body when there is no diff.
//
// Used by the workspace view's middle panel (US-VK-003).

import { execFile } from 'node:child_process';
import * as http from 'node:http';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { getAttempt } from './attempts';

const execFileAsync = promisify(execFile);

const SHA_RE = /^[a-f0-9]{4,40}$/i;

export async function fetchAttemptDiff(
  db: Database.Database,
  id: number,
  opts: { repoRoot?: string } = {},
): Promise<{ patch: string; baseSha: string; headSha: string }> {
  const attempt = getAttempt(db, id);
  if (!attempt) throw Object.assign(new Error(`attempt ${id} not found`), { status: 404 });

  const baseSha = attempt.base_sha ?? '';
  const headSha = attempt.head_sha ?? baseSha;
  if (!SHA_RE.test(baseSha)) throw new Error(`attempt ${id} has invalid base_sha`);
  if (!SHA_RE.test(headSha)) throw new Error(`attempt ${id} has invalid head_sha`);

  if (baseSha === headSha) return { patch: '', baseSha, headSha };

  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--patch', `${baseSha}..${headSha}`],
    { cwd: opts.repoRoot ?? process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  return { patch: stdout, baseSha, headSha };
}

const ATTEMPT_DIFF_RE = /^\/api\/attempts\/(\d+)\/diff\/?$/;

export async function attemptDiffHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const m = url.match(ATTEMPT_DIFF_RE);
  if (!m) return false;
  if (method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `method ${method} not allowed` }));
    return true;
  }
  const id = Number(m[1]);
  try {
    const { patch, baseSha, headSha } = await fetchAttemptDiff(db, id);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Base-Sha': baseSha,
      'X-Head-Sha': headSha,
    });
    res.end(patch);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
  return true;
}
