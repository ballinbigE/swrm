// scripts/pm/lib/worktree.ts — safe git-worktree operations.
//
// Wraps `git worktree add`, `git worktree remove`, and `git diff --stat`
// via execFile (NOT exec) — passing args as an array means shell
// metacharacters in any input are NEVER interpreted by a shell, so an
// attempt branch / path cannot inject. Per the security hook on Write.
//
// Identifiers are also validated up-front so we fail fast on garbage
// before reaching the git binary.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Default worktree root — read at call time so tests can override via
// process.env.PM_WORKTREE_ROOT in beforeEach. macOS wipes /tmp on reboot
// so we live under ~/Library/Application Support/swrm/worktrees so
// in-flight attempts survive a restart. Env var still wins.
function worktreeRoot(): string {
  if (process.env.PM_WORKTREE_ROOT) return process.env.PM_WORKTREE_ROOT;
  return path.join(os.homedir(), 'Library', 'Application Support', 'swrm', 'worktrees');
}

// Branch names: lowercase alphanum + - + _ + / only. Forbids shell
// metachars, whitespace, leading dash, .. traversal.
const BRANCH_RE = /^[a-z0-9][a-z0-9_/-]{0,80}$/;
export function isSafeBranch(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('/') || name.startsWith('/')) return false;
  return true;
}

export function branchForAttempt(taskId: number, attemptNumber: number): string {
  if (!Number.isInteger(taskId) || taskId <= 0) throw new Error(`invalid taskId: ${taskId}`);
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new Error(`invalid attemptNumber: ${attemptNumber}`);
  }
  return `attempt/task-${taskId}-${attemptNumber}`;
}

export function pathForAttempt(taskId: number, attemptNumber: number): string {
  if (!Number.isInteger(taskId) || taskId <= 0) throw new Error(`invalid taskId: ${taskId}`);
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new Error(`invalid attemptNumber: ${attemptNumber}`);
  }
  return path.join(worktreeRoot(), `task-${taskId}-${attemptNumber}`);
}

export interface AddWorktreeResult {
  branch: string;
  worktreePath: string;
  baseSha: string;
}

/**
 * Creates a new git worktree on a fresh branch off `baseRef` (default: main).
 * Returns the branch name, worktree path, and the SHA the branch was cut from.
 *
 * Throws if branch or path is unsafe, or if git fails (e.g. branch exists,
 * path conflicts, repoRoot is not a git repo).
 */
export async function addWorktree(
  taskId: number,
  attemptNumber: number,
  opts: { repoRoot: string; baseRef?: string } = { repoRoot: process.cwd() },
): Promise<AddWorktreeResult> {
  const branch = branchForAttempt(taskId, attemptNumber);
  const worktreePath = pathForAttempt(taskId, attemptNumber);
  const baseRef = opts.baseRef ?? 'main';

  if (!isSafeBranch(branch)) throw new Error(`unsafe branch: ${branch}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Resolve base SHA first so we record the exact commit the attempt
  // branched from (the ref may move).
  const { stdout: baseShaRaw } = await execFileAsync(
    'git',
    ['rev-parse', baseRef],
    { cwd: opts.repoRoot },
  );
  const baseSha = baseShaRaw.trim();

  await execFileAsync(
    'git',
    ['worktree', 'add', '-b', branch, worktreePath, baseSha],
    { cwd: opts.repoRoot },
  );

  return { branch, worktreePath, baseSha };
}

/**
 * Removes a worktree (`git worktree remove --force`) and deletes the local
 * branch if `deleteBranch=true`. Safe to call on a non-existent worktree
 * (git emits a warning to stderr; we swallow non-zero only when it's a
 * "not a working tree" message).
 */
export async function removeWorktree(
  worktreePath: string,
  opts: { repoRoot: string; deleteBranch?: string } = { repoRoot: process.cwd() },
): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: opts.repoRoot },
    );
  } catch (err) {
    const message = (err as { stderr?: string }).stderr ?? (err as Error).message;
    // Tolerate "is not a working tree" — already gone, idempotent cleanup.
    if (!/not a working tree|does not exist/i.test(message)) {
      throw new Error(`worktree remove failed for ${worktreePath}: ${message}`);
    }
  }

  if (opts.deleteBranch) {
    if (!isSafeBranch(opts.deleteBranch)) throw new Error(`unsafe branch: ${opts.deleteBranch}`);
    try {
      await execFileAsync(
        'git',
        ['branch', '-D', opts.deleteBranch],
        { cwd: opts.repoRoot },
      );
    } catch (err) {
      const message = (err as { stderr?: string }).stderr ?? (err as Error).message;
      // Tolerate branch not found.
      if (!/not found|did not match any/i.test(message)) {
        throw new Error(`branch delete failed for ${opts.deleteBranch}: ${message}`);
      }
    }
  }
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Computes `git diff --shortstat baseSha..headRef` and parses the output.
 * Returns zeros when there is no diff.
 */
export async function diffStats(
  baseSha: string,
  headRef: string,
  opts: { repoRoot: string } = { repoRoot: process.cwd() },
): Promise<DiffStats> {
  if (!/^[a-f0-9]{4,40}$/i.test(baseSha)) throw new Error(`invalid baseSha: ${baseSha}`);
  if (!isSafeBranch(headRef) && !/^[a-f0-9]{4,40}$/i.test(headRef)) {
    throw new Error(`unsafe headRef: ${headRef}`);
  }

  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--shortstat', `${baseSha}..${headRef}`],
    { cwd: opts.repoRoot },
  );
  return parseShortstat(stdout);
}

export function parseShortstat(text: string): DiffStats {
  const out: DiffStats = { files: 0, insertions: 0, deletions: 0 };
  const trimmed = text.trim();
  if (trimmed.length === 0) return out;

  const filesMatch = trimmed.match(/(\d+) files? changed/);
  if (filesMatch) out.files = Number(filesMatch[1]);

  const insMatch = trimmed.match(/(\d+) insertions?\(\+\)/);
  if (insMatch) out.insertions = Number(insMatch[1]);

  const delMatch = trimmed.match(/(\d+) deletions?\(-\)/);
  if (delMatch) out.deletions = Number(delMatch[1]);

  return out;
}

/**
 * Returns the current HEAD SHA of a worktree (or any repo at cwd).
 */
export async function headSha(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

export interface CommitInfo {
  sha: string;
  subject: string;
  isoDate: string;
}

/**
 * Lists commits on baseSha..headRef, newest first. Used by the workspace
 * diff pane to render the commit log when no file diff exists yet (or to
 * supplement the diff view with "what commits are in this attempt").
 */
export async function commitsBetween(
  baseSha: string,
  headRef: string,
  opts: { repoRoot: string; limit?: number } = { repoRoot: process.cwd() },
): Promise<CommitInfo[]> {
  if (!/^[a-f0-9]{4,40}$/i.test(baseSha)) return [];
  if (!isSafeBranch(headRef) && !/^[a-f0-9]{4,40}$/i.test(headRef)) return [];
  if (baseSha === headRef) return [];
  const limit = Math.min(opts.limit ?? 50, 200);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `${baseSha}..${headRef}`, '--pretty=format:%H%x09%cI%x09%s', `-n${limit}`],
      { cwd: opts.repoRoot },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, isoDate, ...subjectParts] = line.split('\t');
        return { sha, isoDate: isoDate ?? '', subject: subjectParts.join('\t') };
      });
  } catch {
    return [];
  }
}

/**
 * Garbage-collect dangling worktrees: any directory under WORKTREE_ROOT
 * matching task-N-N that does NOT have a corresponding row in the
 * `attempts` table gets `git worktree remove --force`'d.
 *
 * Catches the case where:
 *   - The rep manually rm -rf'd a worktree (DB still tracks it — that's
 *     handled by removeWorktree's idempotency, not by this function)
 *   - A spawn crashed mid-transaction and left the worktree behind
 *   - macOS rebooted; new attempts inherit stale dirs (less likely
 *     after move off /tmp but still possible)
 *
 * Called from server.ts main() after migrations. Safe to call repeatedly.
 */
export async function gcOrphanWorktrees(
  trackedPaths: Iterable<string>,
  opts: { repoRoot: string } = { repoRoot: process.cwd() },
): Promise<{ removed: string[] }> {
  const root = worktreeRoot();
  if (!fs.existsSync(root)) return { removed: [] };

  const tracked = new Set<string>(trackedPaths);
  const removed: string[] = [];

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^task-\d+-\d+$/.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (tracked.has(full)) continue;
    try {
      await removeWorktree(full, { repoRoot: opts.repoRoot });
      removed.push(full);
    } catch {
      // last-resort filesystem cleanup if `git worktree remove` failed
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch { /* skip */ }
    }
  }
  return { removed };
}
