// Tests for worktree library — focuses on the pure helpers (branch
// naming, path naming, safety predicates, shortstat parser). The
// git-spawning helpers are exercised in an integration test below
// against a real tmp repo (the only way to verify execFile arg-array
// vs shell-string injection actually works in practice).

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  addWorktree,
  branchForAttempt,
  diffStats,
  gcOrphanWorktrees,
  headSha,
  isSafeBranch,
  parseShortstat,
  pathForAttempt,
  removeWorktree,
} from '../worktree';

const execFileAsync = promisify(execFile);

// ── pure helpers ──────────────────────────────────────────────────────────

describe('isSafeBranch', () => {
  it('accepts well-formed branch names', () => {
    expect(isSafeBranch('attempt/task-42-1')).toBe(true);
    expect(isSafeBranch('main')).toBe(true);
    expect(isSafeBranch('feature/foo_bar')).toBe(true);
  });

  it('rejects shell metacharacters', () => {
    expect(isSafeBranch('foo;rm -rf')).toBe(false);
    expect(isSafeBranch('foo&bar')).toBe(false);
    expect(isSafeBranch('foo$(echo)')).toBe(false);
    expect(isSafeBranch('foo`whoami`')).toBe(false);
    expect(isSafeBranch('foo|bar')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isSafeBranch('../etc/passwd')).toBe(false);
    expect(isSafeBranch('foo/..')).toBe(false);
  });

  it('rejects whitespace + leading dash', () => {
    expect(isSafeBranch('foo bar')).toBe(false);
    expect(isSafeBranch('-foo')).toBe(false);
  });

  it('rejects empty and leading/trailing slashes', () => {
    expect(isSafeBranch('')).toBe(false);
    expect(isSafeBranch('/foo')).toBe(false);
    expect(isSafeBranch('foo/')).toBe(false);
  });
});

describe('branchForAttempt + pathForAttempt', () => {
  it('returns deterministic names from ids', () => {
    expect(branchForAttempt(42, 1)).toBe('attempt/task-42-1');
    expect(branchForAttempt(7, 3)).toBe('attempt/task-7-3');
  });

  it('throws on non-positive integers', () => {
    expect(() => branchForAttempt(0, 1)).toThrow(/invalid taskId/);
    expect(() => branchForAttempt(1, 0)).toThrow(/invalid attemptNumber/);
    expect(() => branchForAttempt(-1, 1)).toThrow(/invalid taskId/);
  });

  it('throws on non-integer (no string injection)', () => {
    expect(() => branchForAttempt(1.5, 1)).toThrow(/invalid taskId/);
    expect(() => branchForAttempt(1, NaN)).toThrow(/invalid attemptNumber/);
  });

  it('pathForAttempt produces absolute path under WORKTREE_ROOT', () => {
    const p = pathForAttempt(42, 1);
    expect(p).toMatch(/task-42-1$/);
    expect(path.isAbsolute(p)).toBe(true);
  });
});

// ── parseShortstat ─────────────────────────────────────────────────────────

describe('parseShortstat', () => {
  it('parses full line (files + insertions + deletions)', () => {
    expect(parseShortstat(' 3 files changed, 47 insertions(+), 12 deletions(-)')).toEqual({
      files: 3,
      insertions: 47,
      deletions: 12,
    });
  });

  it('parses single file + only insertions', () => {
    expect(parseShortstat(' 1 file changed, 5 insertions(+)')).toEqual({
      files: 1,
      insertions: 5,
      deletions: 0,
    });
  });

  it('parses only deletions', () => {
    expect(parseShortstat(' 2 files changed, 8 deletions(-)')).toEqual({
      files: 2,
      insertions: 0,
      deletions: 8,
    });
  });

  it('returns zeros on empty input', () => {
    expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseShortstat('   ')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

// ── integration: real git worktree on a throwaway repo ───────────────────

describe('addWorktree + removeWorktree (integration)', () => {
  let repoRoot: string;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wt-test-'));
    repoRoot = path.join(tmpRoot, 'repo');
    fs.mkdirSync(repoRoot);
    process.env.PM_WORKTREE_ROOT = path.join(tmpRoot, 'wts');

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README'), 'hello\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.PM_WORKTREE_ROOT;
  });

  it('addWorktree creates a worktree on a new branch', async () => {
    const result = await addWorktree(42, 1, { repoRoot });
    expect(result.branch).toBe('attempt/task-42-1');
    expect(fs.existsSync(result.worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(result.worktreePath, 'README'))).toBe(true);
    expect(result.baseSha).toMatch(/^[a-f0-9]{40}$/);

    // Cleanup for next test
    await removeWorktree(result.worktreePath, { repoRoot, deleteBranch: result.branch });
  });

  it('removeWorktree is idempotent (safe to call twice)', async () => {
    const result = await addWorktree(42, 2, { repoRoot });
    await removeWorktree(result.worktreePath, { repoRoot, deleteBranch: result.branch });
    // Second call should not throw — already gone.
    await expect(
      removeWorktree(result.worktreePath, { repoRoot, deleteBranch: result.branch }),
    ).resolves.not.toThrow();
  });

  it('diffStats reports 0 for an unchanged worktree, non-zero after a commit', async () => {
    const result = await addWorktree(42, 3, { repoRoot });

    // No changes yet → 0 stats
    const headBefore = await headSha(result.worktreePath);
    const before = await diffStats(result.baseSha, headBefore, { repoRoot });
    expect(before).toEqual({ files: 0, insertions: 0, deletions: 0 });

    // Make a change in the worktree + commit
    fs.writeFileSync(path.join(result.worktreePath, 'NEW.md'), 'line1\nline2\nline3\n');
    await execFileAsync('git', ['add', '.'], { cwd: result.worktreePath });
    await execFileAsync('git', ['commit', '-m', 'add NEW.md'], { cwd: result.worktreePath });

    const headAfter = await headSha(result.worktreePath);
    const after = await diffStats(result.baseSha, headAfter, { repoRoot });
    expect(after.files).toBe(1);
    expect(after.insertions).toBe(3);
    expect(after.deletions).toBe(0);

    await removeWorktree(result.worktreePath, { repoRoot, deleteBranch: result.branch });
  });
});

describe('gcOrphanWorktrees', () => {
  let repoRoot: string;
  let tmpRoot: string;
  let wtRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-gc-test-'));
    repoRoot = path.join(tmpRoot, 'repo');
    wtRoot = path.join(tmpRoot, 'wts');
    fs.mkdirSync(repoRoot);
    fs.mkdirSync(wtRoot, { recursive: true });
    process.env.PM_WORKTREE_ROOT = wtRoot;

    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 't@e'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'R'), 'x');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.PM_WORKTREE_ROOT;
  });

  it('removes worktree dirs that are not in the tracked set', async () => {
    const tracked = await addWorktree(99, 1, { repoRoot });
    const orphan = await addWorktree(99, 2, { repoRoot });

    // Drop only `tracked` from the set; orphan should be GC'd
    const result = await gcOrphanWorktrees([tracked.worktreePath], { repoRoot });

    expect(result.removed).toContain(orphan.worktreePath);
    expect(result.removed).not.toContain(tracked.worktreePath);
    expect(fs.existsSync(tracked.worktreePath)).toBe(true);
    expect(fs.existsSync(orphan.worktreePath)).toBe(false);

    await removeWorktree(tracked.worktreePath, { repoRoot, deleteBranch: tracked.branch });
  });

  it('returns empty when root does not exist yet', async () => {
    process.env.PM_WORKTREE_ROOT = path.join(tmpRoot, 'does-not-exist');
    const result = await gcOrphanWorktrees([], { repoRoot });
    expect(result.removed).toEqual([]);
    process.env.PM_WORKTREE_ROOT = wtRoot;
  });

  it('ignores non-attempt-shaped directories', async () => {
    const stray = path.join(wtRoot, 'not-an-attempt');
    fs.mkdirSync(stray, { recursive: true });
    const result = await gcOrphanWorktrees([], { repoRoot });
    expect(result.removed).not.toContain(stray);
    expect(fs.existsSync(stray)).toBe(true);
    fs.rmSync(stray, { recursive: true, force: true });
  });
});
