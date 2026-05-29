import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { loadTaskList, renderTasksListHtml } from '../tasks_list';

const ALL_MIGRATIONS = [
  '001_init.sql', '003_attempts.sql', '004_attempt_comments.sql',
  '005_chat_message_scope.sql', '006_external_md_ref.sql',
  '007_attempts_repo_root.sql', '008_board_workflow.sql',
  '009_skills.sql', '010_agent_runs_skill_link.sql', '011_projects.sql',
];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ALL_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  // Boards belong to the default project (inserted by 011_projects.sql migration).
  const defaultProject = db.prepare(`SELECT id FROM projects WHERE slug = 'default'`).get() as { id: number };
  db.prepare(`INSERT INTO boards (slug, name, project_id) VALUES ('personal', 'Personal', ?)`).run(defaultProject.id);
  db.prepare(`INSERT INTO boards (slug, name, project_id) VALUES ('work', 'Work', ?)`).run(defaultProject.id);
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

  it('filters by project slug — returns only that project\'s tasks', () => {
    const db = makeDb();
    // Create a second project with its own board + task.
    const os = require('node:os');
    db.prepare(`INSERT INTO projects (slug, name, root_path, position) VALUES ('alpha', 'Alpha', ?, 1)`).run(os.tmpdir());
    const alphaProject = db.prepare(`SELECT id FROM projects WHERE slug = 'alpha'`).get() as { id: number };
    db.prepare(`INSERT INTO boards (slug, name, project_id) VALUES ('alpha-board', 'Alpha Board', ?)`).run(alphaProject.id);
    const alphaBoard = db.prepare(`SELECT id FROM boards WHERE slug = 'alpha-board'`).get() as { id: number };
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (?, 'alpha task', 'backlog')`).run(alphaBoard.id);

    // Also insert a task on the default project board.
    db.prepare(`INSERT INTO tasks (board_id, title, status) VALUES (1, 'default task', 'backlog')`).run();

    // project=alpha should only return the alpha task.
    const alphaRows = loadTaskList(db, { project: 'alpha' });
    expect(alphaRows.map((r) => r.title)).toEqual(['alpha task']);

    // project=default should only return the default task.
    const defaultRows = loadTaskList(db, { project: 'default' });
    expect(defaultRows.map((r) => r.title)).toEqual(['default task']);
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
          open_comment_count: 0, external_md_ref: null, labels_raw: null,
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
          attempt_count: 0, open_comment_count: 0, external_md_ref: null, labels_raw: null,
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
