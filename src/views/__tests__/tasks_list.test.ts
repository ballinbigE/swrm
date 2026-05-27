import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { loadTaskList, renderTasksListHtml } from '../tasks_list';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql', '006_external_md_ref.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('work', 'Work')`).run();
  return db;
}

describe('loadTaskList', () => {
  it('returns empty when no tasks', () => {
    expect(loadTaskList(makeDb())).toEqual([]);
  });

  it('orders in_progress > todo > review > backlog', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'a', 'backlog')`).run();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'b', 'review')`).run();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'c', 'in_progress')`).run();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'd', 'todo')`).run();
    const rows = loadTaskList(db);
    expect(rows.map((r) => r.title)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('filters by board slug', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 'p')`).run();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (2, 'w')`).run();
    expect(loadTaskList(db, { board: 'work' }).map((r) => r.title)).toEqual(['w']);
  });

  it('filters by status', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'a', 'in_progress')`).run();
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'b', 'done')`).run();
    expect(loadTaskList(db, { status: 'done' }).map((r) => r.title)).toEqual(['b']);
  });

  it('excludes archived', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title, archived_at) VALUES (1, 'gone', datetime('now'))`).run();
    expect(loadTaskList(db)).toEqual([]);
  });

  it('counts attempts + open comments', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO tasks (board_id, title) VALUES (1, 't')`).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, branch_name, worktree_path, agent_name)
       VALUES (1, 1, 'attempt/task-1-1', '/tmp/a', 'claude-code')`,
    ).run();
    db.prepare(`INSERT INTO attempt_comments (attempt_id, body) VALUES (1, 'fix')`).run();
    db.prepare(`INSERT INTO attempt_comments (attempt_id, body, resolved) VALUES (1, 'done', 1)`).run();

    const rows = loadTaskList(db);
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[0].open_comment_count).toBe(1);
  });
});

describe('renderTasksListHtml', () => {
  it('shows empty message when 0 rows', () => {
    const html = renderTasksListHtml([], {});
    expect(html).toContain('no tasks matching filters');
  });

  it('renders a link to /workspace/:id per row', () => {
    const html = renderTasksListHtml(
      [
        {
          id: 42,
          board_slug: 'personal',
          board_name: 'Personal',
          title: 'wire MCP',
          status: 'in_progress',
          priority: 'high',
          effort_hours: null,
          due_date: null,
          attempt_count: 0,
          open_comment_count: 0, external_md_ref: null,
        },
      ],
      {},
    );
    expect(html).toContain('/workspace/42');
    expect(html).toContain('wire MCP');
    expect(html).toContain('priority-high');
  });

  it('escapes title (XSS)', () => {
    const html = renderTasksListHtml(
      [
        {
          id: 1, board_slug: 'p', board_name: 'P', title: '<script>x</script>',
          status: 'backlog', priority: null, effort_hours: null, due_date: null,
          attempt_count: 0, open_comment_count: 0, external_md_ref: null,
        },
      ],
      {},
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('marks active status filter', () => {
    const html = renderTasksListHtml([], { status: 'in_progress' });
    expect(html).toMatch(/class="active"[^>]*>in_progress/);
  });
});
