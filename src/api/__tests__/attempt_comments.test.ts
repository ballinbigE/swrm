// Tests for the attempt_comments API + reprompt bundler.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import {
  bundleReprompt,
  createComment,
  deleteComment,
  getComment,
  listComments,
  updateComment,
} from '../attempt_comments';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 't')`).run();
  db.prepare(
    `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name, base_sha, head_sha)
     VALUES (1, 1, 'attempt/task-1-1', '/tmp/wt', 'claude-code', 'abc1234abc1234abc1234abc1234abc1234abc1', 'def5678def5678def5678def5678def5678def5')`,
  ).run();
  return db;
}

describe('createComment', () => {
  it('inserts row + fans out to chat_messages', () => {
    const db = makeDb();
    const c = createComment(db, 1, { body: 'fix this', file_path: 'src/foo.ts', line_number: 10, diff_line: '+const x = 1;' });
    expect(c.body).toBe('fix this');
    expect(c.file_path).toBe('src/foo.ts');
    expect(c.line_number).toBe(10);
    expect(c.resolved).toBe(0);

    const chat = db.prepare(`SELECT * FROM chat_messages`).all() as Array<{ role: string; content: string }>;
    expect(chat).toHaveLength(1);
    expect(chat[0].role).toBe('user');
    expect(chat[0].content).toContain('src/foo.ts:10');
    expect(chat[0].content).toContain('fix this');
  });

  it('refuses empty body', () => {
    const db = makeDb();
    expect(() => createComment(db, 1, { body: '' })).toThrow(/body \(non-empty/);
    expect(() => createComment(db, 1, { body: '   ' })).toThrow(/body \(non-empty/);
  });

  it('refuses unknown attempt', () => {
    const db = makeDb();
    expect(() => createComment(db, 9999, { body: 'x' })).toThrow(/attempt 9999 not found/);
  });

  it('allows file-level comment (no line_number)', () => {
    const db = makeDb();
    const c = createComment(db, 1, { body: 'overall ugly', file_path: 'src/foo.ts' });
    expect(c.line_number).toBeNull();
  });

  it('normalizes invalid line_number to null', () => {
    const db = makeDb();
    const c = createComment(db, 1, { body: 'x', line_number: -5 });
    expect(c.line_number).toBeNull();
  });
});

describe('listComments', () => {
  it('newest first', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'first' });
    createComment(db, 1, { body: 'second' });
    const rows = listComments(db, 1);
    expect(rows.map((r) => r.body)).toEqual(['second', 'first']);
  });
});

describe('updateComment', () => {
  it('toggles resolved + stamps resolved_at', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'fix' });
    const updated = updateComment(db, 1, { resolved: true });
    expect(updated.resolved).toBe(1);
    expect(updated.resolved_at).not.toBeNull();

    const reopened = updateComment(db, 1, { resolved: false });
    expect(reopened.resolved).toBe(0);
    expect(reopened.resolved_at).toBeNull();
  });

  it('rejects empty body patch', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'fix' });
    expect(() => updateComment(db, 1, { body: '' })).toThrow(/body cannot be empty/);
  });

  it('errors on empty patch', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'fix' });
    expect(() => updateComment(db, 1, {})).toThrow(/patch is empty/);
  });

  it('errors on unknown comment id', () => {
    const db = makeDb();
    expect(() => updateComment(db, 999, { resolved: true })).toThrow(/comment 999 not found/);
  });
});

describe('deleteComment', () => {
  it('returns false for missing', () => {
    const db = makeDb();
    expect(deleteComment(db, 999)).toBe(false);
  });
  it('removes the row', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'fix' });
    expect(deleteComment(db, 1)).toBe(true);
    expect(getComment(db, 1)).toBeNull();
  });
});

describe('bundleReprompt', () => {
  it('returns empty prompt when no open comments', () => {
    const db = makeDb();
    const r = bundleReprompt(db, 1);
    expect(r.prompt).toBe('');
    expect(r.comment_ids).toEqual([]);
  });

  it('bundles open comments into a formatted prompt + inserts system chat msg', () => {
    const db = makeDb();
    createComment(db, 1, { body: 'tighten this', file_path: 'src/foo.ts', line_number: 10, diff_line: '+let x = 1;' });
    createComment(db, 1, { body: 'add a test', file_path: 'src/bar.ts' });
    updateComment(db, 1, { resolved: true }); // resolved should be excluded

    const r = bundleReprompt(db, 1);
    expect(r.comment_ids).toEqual([2]); // only the open one
    expect(r.prompt).toContain('attempt #1');
    expect(r.prompt).toContain('src/bar.ts');
    expect(r.prompt).toContain('add a test');
    expect(r.prompt).not.toContain('tighten this');

    const chat = db.prepare(`SELECT role, content FROM chat_messages WHERE role = 'system'`).all() as Array<{ content: string }>;
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain('add a test');
  });

  it('errors on unknown attempt', () => {
    const db = makeDb();
    expect(() => bundleReprompt(db, 999)).toThrow(/attempt 999 not found/);
  });
});
