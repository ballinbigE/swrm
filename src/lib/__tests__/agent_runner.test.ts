// Tests for agent_runner using `sh -c` as a fake agent binary.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runAgentInWorktree } from '../agent_runner';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('p', 'P')`).run();
  db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 't')`).run();
  db.prepare(
    `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name, base_sha, head_sha)
     VALUES (1, 1, 'attempt/task-1-1', '/tmp', 'claude-code',
             'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
             'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4')`,
  ).run();
  return db;
}

const ATTEMPT = (db: Database.Database) =>
  db.prepare(`SELECT id, task_id, agent_name, worktree_path FROM attempts WHERE id = 1`).get() as {
    id: number;
    task_id: number;
    agent_name: string;
    worktree_path: string;
  };

describe('runAgentInWorktree (fake binary)', () => {
  it('streams stdout lines into chat_messages and marks completed', async () => {
    const db = makeDb();
    const result = await runAgentInWorktree(db, ATTEMPT(db), {
      binary: 'sh',
      args: ['-c', 'echo line1; echo line2; echo line3'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.linesCaptured).toBe(3);

    const msgs = db.prepare(`SELECT role, content FROM chat_messages ORDER BY id`).all() as Array<{
      role: string;
      content: string;
    }>;
    expect(msgs.map((m) => m.content)).toEqual(['line1', 'line2', 'line3']);
    expect(msgs.every((m) => m.role === 'assistant')).toBe(true);

    const status = (db.prepare(`SELECT status, completed_at FROM attempts WHERE id = 1`).get() as {
      status: string;
      completed_at: string | null;
    });
    expect(status.status).toBe('completed');
    expect(status.completed_at).not.toBeNull();
  });

  it('captures stderr as role=system', async () => {
    const db = makeDb();
    const result = await runAgentInWorktree(db, ATTEMPT(db), {
      binary: 'sh',
      args: ['-c', 'echo to-out; echo to-err 1>&2'],
    });
    expect(result.exitCode).toBe(0);
    const msgs = db.prepare(`SELECT role, content FROM chat_messages ORDER BY id`).all() as Array<{
      role: string;
      content: string;
    }>;
    const assistant = msgs.filter((m) => m.role === 'assistant').map((m) => m.content);
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content);
    expect(assistant).toEqual(['to-out']);
    expect(system).toEqual(['to-err']);
  });

  it('marks failed on non-zero exit', async () => {
    const db = makeDb();
    const result = await runAgentInWorktree(db, ATTEMPT(db), {
      binary: 'sh',
      args: ['-c', 'echo before-fail; exit 7'],
    });
    expect(result.exitCode).toBe(7);
    const status = (db.prepare(`SELECT status FROM attempts WHERE id = 1`).get() as { status: string }).status;
    expect(status).toBe('failed');
  });

  it('marks failed on spawn error (missing binary)', async () => {
    const db = makeDb();
    const result = await runAgentInWorktree(db, ATTEMPT(db), {
      binary: '/does/not/exist/no-way',
    });
    expect(result.exitCode).toBe(-1);
    const status = (db.prepare(`SELECT status FROM attempts WHERE id = 1`).get() as { status: string }).status;
    expect(status).toBe('failed');
  });

  it('no-op for agent_name=manual (no subprocess, status untouched)', async () => {
    const db = makeDb();
    db.prepare(`UPDATE attempts SET agent_name = 'manual' WHERE id = 1`).run();
    const result = await runAgentInWorktree(db, ATTEMPT(db));
    expect(result.exitCode).toBe(0);
    expect(result.linesCaptured).toBe(0);
    const status = (db.prepare(`SELECT status FROM attempts WHERE id = 1`).get() as { status: string }).status;
    expect(status).toBe('running'); // not touched
  });

  it('PM_AGENT_BINARY_<NAME> env var overrides default', async () => {
    const db = makeDb();
    process.env.PM_AGENT_BINARY_CLAUDE_CODE = 'sh';
    try {
      const result = await runAgentInWorktree(db, ATTEMPT(db), {
        args: ['-c', 'echo from-env'],
      });
      expect(result.exitCode).toBe(0);
      const msgs = db.prepare(`SELECT content FROM chat_messages`).all() as Array<{ content: string }>;
      expect(msgs[0].content).toBe('from-env');
    } finally {
      delete process.env.PM_AGENT_BINARY_CLAUDE_CODE;
    }
  });
});
