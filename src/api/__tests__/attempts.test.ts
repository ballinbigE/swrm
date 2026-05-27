// Tests for the attempts API — uses real git in a throwaway repo to
// exercise the actual worktree spawn + cleanup paths.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import {
  createAttempt,
  deleteAttempt,
  getAttempt,
  listAttempts,
  mergeAttempt,
  updateAttempt,
} from '../attempts';

const execFileAsync = promisify(execFile);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql', '006_external_md_ref.sql', '007_attempts_repo_root.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  return db;
}

describe('attempts API (real git)', () => {
  let tmpRoot: string;
  let repoRoot: string;
  let db: Database.Database;
  let taskId: number;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-attempts-test-'));
    repoRoot = path.join(tmpRoot, 'repo');
    fs.mkdirSync(repoRoot);
    process.env.PM_WORKTREE_ROOT = path.join(tmpRoot, 'wts');

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README'), 'hello\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    db = makeDb();
    const r = db
      .prepare(`INSERT INTO tasks (board_id, title) VALUES ((SELECT id FROM boards WHERE slug='personal'), 'a task')`)
      .run();
    taskId = r.lastInsertRowid as number;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.PM_WORKTREE_ROOT;
  });

  it('createAttempt spawns worktree + records row', async () => {
    const attempt = await createAttempt(db, taskId, { repo_root: repoRoot });
    expect(attempt.attempt_number).toBe(1);
    expect(attempt.branch_name).toBe(`attempt/task-${taskId}-1`);
    expect(attempt.status).toBe('running');
    expect(attempt.agent_name).toBe('claude-code');
    expect(fs.existsSync(attempt.worktree_path)).toBe(true);
    expect(fs.existsSync(path.join(attempt.worktree_path, 'README'))).toBe(true);
    expect(attempt.base_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(attempt.head_sha).toBe(attempt.base_sha);
  });

  it('createAttempt increments attempt_number per task', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    const b = await createAttempt(db, taskId, { repo_root: repoRoot });
    expect(a.attempt_number).toBe(1);
    expect(b.attempt_number).toBe(2);
  });

  it('createAttempt 404s on missing task', async () => {
    await expect(createAttempt(db, 9999, { repo_root: repoRoot })).rejects.toThrow(/task 9999 not found/);
  });

  it('createAttempt rejects invalid agent_name (no injection)', async () => {
    await expect(
      createAttempt(db, taskId, { repo_root: repoRoot, agent_name: 'foo; rm -rf' }),
    ).rejects.toThrow(/invalid agent_name/);
  });

  it('listAttempts returns rows in attempt_number order', async () => {
    await createAttempt(db, taskId, { repo_root: repoRoot });
    await createAttempt(db, taskId, { repo_root: repoRoot });
    const rows = listAttempts(db, taskId);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2]);
  });

  it('createAttempt rolls back the worktree when DB INSERT throws', async () => {
    // Make the INSERT explode by spying on db.prepare to throw on attempts INSERT
    const originalPrepare = db.prepare.bind(db);
    let worktreePathSeen: string | null = null;
    const spy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('INSERT INTO attempts')) {
        return { run: () => { throw new Error('simulated DB failure'); } } as unknown as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare(sql);
    }) as never);

    // Predict the worktree path createAttempt will use (next attempt_number)
    const next = (db.prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM attempts WHERE task_id = ?`)
      .get(taskId) as { n: number } | undefined)?.n ?? 1;

    // Re-stub prepare for the path-prediction query above
    spy.mockRestore();
    const spy2 = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith('INSERT INTO attempts')) {
        return { run: () => { throw new Error('simulated DB failure'); } } as unknown as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare(sql);
    }) as never);

    try {
      await expect(createAttempt(db, taskId, { repo_root: repoRoot })).rejects.toThrow(/simulated DB failure/);
      worktreePathSeen = require('path').join(
        process.env.PM_WORKTREE_ROOT as string,
        `task-${taskId}-${next}`,
      );
      // Rollback should have removed the worktree dir
      expect(require('fs').existsSync(worktreePathSeen)).toBe(false);
    } finally {
      spy2.mockRestore();
    }
  });

  it('updateAttempt patches status + stamps completed_at', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    const updated = await updateAttempt(db, a.id, { status: 'completed', summary: 'shipped' });
    expect(updated.status).toBe('completed');
    expect(updated.summary).toBe('shipped');
    expect(updated.completed_at).not.toBeNull();
  });

  it('updateAttempt rejects invalid status enum', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    await expect(updateAttempt(db, a.id, { status: 'banana' as never })).rejects.toThrow(/invalid status/);
  });

  it('updateAttempt rejects invalid head_sha (no injection)', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    await expect(updateAttempt(db, a.id, { head_sha: 'not-a-sha; whoami' })).rejects.toThrow(/invalid head_sha/);
  });

  it('updateAttempt refresh_diff computes diff_stats after a commit', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });

    fs.writeFileSync(path.join(a.worktree_path, 'NEW.md'), 'line1\nline2\n');
    await execFileAsync('git', ['add', '.'], { cwd: a.worktree_path });
    await execFileAsync('git', ['commit', '-m', 'add NEW'], { cwd: a.worktree_path });

    const updated = await updateAttempt(db, a.id, { refresh_diff: true }, { repoRoot });
    const stats = JSON.parse(updated.diff_stats ?? 'null') as { files: number; insertions: number; deletions: number };
    expect(stats.files).toBe(1);
    expect(stats.insertions).toBe(2);
    expect(updated.head_sha).not.toBe(a.base_sha);
  });

  it('deleteAttempt removes worktree + branch + row', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    const wt = a.worktree_path;

    const ok = await deleteAttempt(db, a.id, { repoRoot });
    expect(ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(getAttempt(db, a.id)).toBeNull();

    // Branch should be gone too
    const { stdout } = await execFileAsync('git', ['branch'], { cwd: repoRoot });
    expect(stdout).not.toContain(a.branch_name);
  });

  it('deleteAttempt returns false for unknown id', async () => {
    expect(await deleteAttempt(db, 9999, { repoRoot })).toBe(false);
  });

  it('mergeAttempt fast-forwards a clean attempt into main', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    require('fs').writeFileSync(require('path').join(a.worktree_path, 'M.md'), 'hi\n');
    await execFileAsync('git', ['add', '.'], { cwd: a.worktree_path });
    await execFileAsync('git', ['commit', '-m', 'add M'], { cwd: a.worktree_path });

    const result = await mergeAttempt(db, a.id, { repoRoot });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mergedSha).toMatch(/^[a-f0-9]{40}$/);

    // main now contains M.md
    const { stdout } = await execFileAsync('git', ['log', '--name-only', '--format='], { cwd: repoRoot });
    expect(stdout).toContain('M.md');

    // attempt status flipped + worktree gone
    const row = getAttempt(db, a.id);
    expect(row!.status).toBe('completed');
    expect(require('fs').existsSync(a.worktree_path)).toBe(false);
  });

  it('mergeAttempt refuses failed attempts', async () => {
    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    await updateAttempt(db, a.id, { status: 'failed' });
    const result = await mergeAttempt(db, a.id, { repoRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('failed');
  });

  it('multi-repo: attempts in different repo_roots stay isolated', async () => {
    // Build a second throwaway repo for this test only
    const repoB = require('path').join(tmpRoot, 'repo-b');
    require('fs').mkdirSync(repoB);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoB });
    await execFileAsync('git', ['config', 'user.email', 'b@b'], { cwd: repoB });
    await execFileAsync('git', ['config', 'user.name', 'b'], { cwd: repoB });
    require('fs').writeFileSync(require('path').join(repoB, 'B'), 'b\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoB });
    await execFileAsync('git', ['commit', '-m', 'init b'], { cwd: repoB });

    const a = await createAttempt(db, taskId, { repo_root: repoRoot });
    const b = await createAttempt(db, taskId, { repo_root: repoB });

    expect(a.repo_root).toBe(repoRoot);
    expect(b.repo_root).toBe(repoB);

    // Both worktrees should exist + each branch should only live in its own repo
    expect(require('fs').existsSync(a.worktree_path)).toBe(true);
    expect(require('fs').existsSync(b.worktree_path)).toBe(true);

    const { stdout: branchesA } = await execFileAsync('git', ['branch'], { cwd: repoRoot });
    const { stdout: branchesB } = await execFileAsync('git', ['branch'], { cwd: repoB });
    expect(branchesA).toContain(a.branch_name);
    expect(branchesA).not.toContain(b.branch_name);
    expect(branchesB).toContain(b.branch_name);
    expect(branchesB).not.toContain(a.branch_name);

    // deleteAttempt should operate on its own repo
    await deleteAttempt(db, b.id);
    expect(require('fs').existsSync(b.worktree_path)).toBe(false);
    expect(require('fs').existsSync(a.worktree_path)).toBe(true);

    await deleteAttempt(db, a.id);
  });
});
