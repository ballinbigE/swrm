// Tests for the workspace HTML renderer + payload loader.
// Pure render tests use a hand-built payload; loadWorkspacePayload tests
// hit a seeded in-memory SQLite.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { buildSpawnPromptDefault, loadWorkspacePayload, renderWorkspaceHtml, type WorkspacePayload } from '../workspace';
import type { AttemptRow } from '../../api/attempts';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql', '006_external_md_ref.sql', '007_attempts_repo_root.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', file), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  return db;
}

function fakeAttempt(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 1,
    task_id: 1,
    attempt_number: 1,
    branch_name: 'attempt/task-1-1',
    worktree_path: '/tmp/pm-wt/task-1-1',
    agent_name: 'claude-code',
    status: 'running',
    summary: null,
    diff_stats: null,
    base_sha: 'a'.repeat(40),
    head_sha: 'a'.repeat(40),
    created_at: '2026-05-27 12:00:00',
    completed_at: null,
    repo_root: '',
    ...overrides,
  };
}

describe('renderWorkspaceHtml', () => {
  const baseTask = { id: 1, title: 'wire MCP', status: 'in_progress', priority: 'high', description: null, board_id: 1 };

  it('renders task title + status pill', () => {
    const html = renderWorkspaceHtml({ task: baseTask, attempts: [], activeAttempt: null, chat: [], comments: [], diff: null, commits: [] });
    expect(html).toContain('#1 wire MCP');
    expect(html).toContain('status-in_progress');
  });

  it('shows "no attempts yet" empty state when none', () => {
    const html = renderWorkspaceHtml({ task: baseTask, attempts: [], activeAttempt: null, chat: [], comments: [], diff: null, commits: [] });
    expect(html).toContain('no attempts yet');
  });

  it('renders attempts dropdown with active selected', () => {
    const a1 = fakeAttempt({ id: 1, attempt_number: 1 });
    const a2 = fakeAttempt({ id: 2, attempt_number: 2, agent_name: 'codex' });
    const html = renderWorkspaceHtml({
      task: baseTask,
      attempts: [a1, a2],
      activeAttempt: a2,
      chat: [],
      comments: [],
      diff: null,
      commits: [],
    });
    expect(html).toContain('<option value="2"');
    expect(html).toMatch(/value="2"\s+selected/);
    expect(html).toContain('codex');
  });

  it('escapes task title (XSS guard)', () => {
    const html = renderWorkspaceHtml({
      task: { ...baseTask, title: '<script>alert(1)</script>' },
      attempts: [], activeAttempt: null, chat: [], comments: [], diff: null, commits: [],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('escapes chat content', () => {
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [], activeAttempt: null,
      chat: [{ id: 1, role: 'user', content: '<img src=x onerror=alert(1)>', created_at: '2026-05-27' }],
      comments: [],
      diff: null,
      commits: [],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('renders quickstart when patch is empty and no commits', () => {
    const html = renderWorkspaceHtml({
      task: baseTask,
      attempts: [fakeAttempt()],
      activeAttempt: fakeAttempt(),
      chat: [],
      comments: [],
      diff: { patch: '', baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) },
      commits: [],
    });
    expect(html).toContain('Worktree is empty');
    expect(html).toContain('class="quickstart"');
  });

  it('renders commit log when commits exist with no file diff', () => {
    const html = renderWorkspaceHtml({
      task: baseTask,
      attempts: [fakeAttempt()],
      activeAttempt: fakeAttempt(),
      chat: [],
      comments: [],
      diff: { patch: '', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      commits: [
        { sha: 'abc1234defabc1234defabc1234defabc1234de', subject: 'add NEW.md', isoDate: '2026-05-27T12:00:00Z' },
      ],
    });
    expect(html).toContain('Commits in this attempt');
    expect(html).toContain('add NEW.md');
    expect(html).toContain('abc1234');
  });

  it('colorizes diff add/del/hunk/file lines', () => {
    const patch = [
      'diff --git a/foo.ts b/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
    ].join('\n');
    const html = renderWorkspaceHtml({
      task: baseTask,
      attempts: [fakeAttempt()],
      activeAttempt: fakeAttempt(),
      chat: [],
      comments: [],
      diff: { patch, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
      commits: [],
    });
    expect(html).toContain('class="diff-line file"');
    expect(html).toContain('hunk');
    expect(html).toContain('add');
    expect(html).toContain('del');
  });

  it('shows base→head SHA prefix in attempt-info', () => {
    const a = fakeAttempt({ base_sha: 'abc1234' + 'd'.repeat(33), head_sha: 'fed9876' + 'e'.repeat(33) });
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [a], activeAttempt: a, chat: [],
      comments: [],
      diff: { patch: '', baseSha: a.base_sha!, headSha: a.head_sha! },
      commits: [],
    });
    expect(html).toContain('abc1234');
    expect(html).toContain('fed9876');
  });
});

describe('Convo | Logs tab switcher', () => {
  const baseTask = { id: 1, title: 'wire MCP', status: 'in_progress', priority: 'high', description: null, board_id: 1 };

  it('renders both tabs in the conversation pane header', () => {
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [], activeAttempt: null,
      chat: [], comments: [], diff: null, commits: [],
    });
    expect(html).toContain('class="tab-switcher"');
    expect(html).toMatch(/data-tab="convo"[^>]*>Convo/);
    expect(html).toMatch(/data-tab="logs"[^>]*>Logs/);
  });

  it('Logs tab counts only assistant + system messages', () => {
    const chat = [
      { id: 1, role: 'user', content: '[#1] feedback', created_at: '2026-05-27T12:00:00Z' },
      { id: 2, role: 'assistant', content: 'building...', created_at: '2026-05-27T12:01:00Z' },
      { id: 3, role: 'system', content: '[err]', created_at: '2026-05-27T12:02:00Z' },
      { id: 4, role: 'assistant', content: 'done', created_at: '2026-05-27T12:03:00Z' },
    ];
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [], activeAttempt: null,
      chat, comments: [], diff: null, commits: [],
    });
    expect(html).toMatch(/id="log-count">3</);
  });

  it('Logs tab body shows empty state when no agent output', () => {
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [], activeAttempt: null,
      chat: [{ id: 1, role: 'user', content: 'x', created_at: 'now' }],
      comments: [], diff: null, commits: [],
    });
    expect(html).toContain('no agent output yet');
  });

  it('Logs tab body renders assistant lines as terminal log-line entries', () => {
    const html = renderWorkspaceHtml({
      task: baseTask, attempts: [], activeAttempt: null,
      chat: [
        { id: 1, role: 'assistant', content: 'compiling foo.ts', created_at: '2026-05-27T12:00:00Z' },
      ],
      comments: [], diff: null, commits: [],
    });
    expect(html).toContain('class="log-line log-assistant"');
    expect(html).toContain('compiling foo.ts');
  });
});

describe('buildSpawnPromptDefault', () => {
  it('returns empty string for title only (no desc, no comments)', () => {
    const out = buildSpawnPromptDefault({ title: 'wire MCP', description: null });
    expect(out).toBe('');
  });

  it('renders task title + description when description exists', () => {
    const out = buildSpawnPromptDefault({ title: 'wire MCP', description: 'expose pm__* tools' });
    expect(out).toContain('Task: wire MCP');
    expect(out).toContain('expose pm__* tools');
  });

  it('appends open comments with file:line locator', () => {
    const out = buildSpawnPromptDefault(
      { title: 'wire MCP', description: 'expose tools' },
      [
        { file_path: 'src/foo.ts', line_number: 10, body: 'rename this' },
        { file_path: 'src/bar.ts', line_number: null, body: 'add a doc comment' },
        { file_path: null, line_number: null, body: 'overall LGTM but…' },
      ],
    );
    expect(out).toContain('Open feedback:');
    expect(out).toContain('src/foo.ts:10 — rename this');
    expect(out).toContain('src/bar.ts — add a doc comment');
    expect(out).toContain('file-level — overall LGTM');
  });
});

describe('loadWorkspacePayload', () => {
  it('returns null for unknown task', () => {
    const db = makeDb();
    expect(loadWorkspacePayload(db, 9999, null)).toBeNull();
  });

  it('returns task + empty attempts when none exist', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 'fresh')`).run();
    const payload = loadWorkspacePayload(db, 1, null);
    expect(payload).not.toBeNull();
    expect(payload!.task.title).toBe('fresh');
    expect(payload!.attempts).toEqual([]);
    expect(payload!.activeAttempt).toBeNull();
  });

  it('defaults activeAttempt to the latest attempt when none specified', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 't')`).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name)
       VALUES (1, 1, 'attempt/task-1-1', '/tmp/a', 'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name)
       VALUES (1, 2, 'attempt/task-1-2', '/tmp/b', 'codex')`,
    ).run();
    const payload = loadWorkspacePayload(db, 1, null);
    expect(payload!.activeAttempt?.attempt_number).toBe(2);
  });

  it('honors explicit activeAttemptId', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 't')`).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name)
       VALUES (1, 1, 'attempt/task-1-1', '/tmp/a', 'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name)
       VALUES (1, 2, 'attempt/task-1-2', '/tmp/b', 'codex')`,
    ).run();
    const payload = loadWorkspacePayload(db, 1, 1);
    expect(payload!.activeAttempt?.attempt_number).toBe(1);
  });
});
