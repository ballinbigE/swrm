// Tests for sync_md parser + reconciler.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { parseBacklogMd, syncMarkdownToSqlite, syncProjectMarkdown } from '../sync_md';

/** Minimal DB with only the migrations needed for basic sync tests (no projects table). */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of [
    '001_init.sql',
    '003_attempts.sql',
    '004_attempt_comments.sql',
    '005_chat_message_scope.sql',
    '006_external_md_ref.sql',
  ]) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  return db;
}

/** Full DB including all migrations (for project/board FK tests). */
function makeFullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const exec = (sql: string) => (db as { exec(s: string): void }).exec(sql);

  for (const f of [
    '001_init.sql',
    '003_attempts.sql',
    '004_attempt_comments.sql',
    '005_chat_message_scope.sql',
    '006_external_md_ref.sql',
    '007_attempts_repo_root.sql',
    '008_board_workflow.sql',
    '009_skills.sql',
    '010_agent_runs_skill_link.sql',
  ]) {
    exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  // Seed a board before running 011 so the UPDATE...SET project_id link fires.
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  exec(fs.readFileSync(path.join(migrationsDir, '011_projects.sql'), 'utf8'));

  // 011 inserts project 'default' with root_path '__SWRM_ROOT__'; tests
  // override it per-test via UPDATE.
  return db;
}

describe('parseBacklogMd', () => {
  it('extracts open + closed checkbox rows with line_ref', () => {
    const md = [
      '# Backlog',
      '',
      '- [ ] **Wire MCP** — shipped via /api/pm',
      '- [x] **parseVoice extractor** — shipped 2026-05-26',
      '',
      '## L729 — heading not a checkbox',
      '- [ ] **Auto-refresh diff** (P1)',
    ].join('\n');
    const rows = parseBacklogMd(md, 'todo.md');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(expect.objectContaining({
      title: 'Wire MCP', status: 'backlog', line_ref: 'todo.md:3',
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      title: 'parseVoice extractor', status: 'done', line_ref: 'todo.md:4',
    }));
    expect(rows[2]).toEqual(expect.objectContaining({
      title: 'Auto-refresh diff', status: 'backlog', line_ref: 'todo.md:7',
      priority: 'high',
    }));
  });

  it('handles strikethrough wrappers', () => {
    const md = '- [ ] ~~stale row~~ — backed out';
    const rows = parseBacklogMd(md, 'x.md');
    expect(rows[0].title).toBe('stale row');
  });

  it('drops empty titles', () => {
    const md = '- [ ] \n- [ ] **\n';
    expect(parseBacklogMd(md, 'x.md').filter((r) => r.title.length > 0)).toHaveLength(0);
  });

  it('infers priority from P0..P4', () => {
    const md = [
      '- [ ] **P0 task** (P0)',
      '- [ ] **P2 task** (P2)',
      '- [ ] **P4 task** (P4)',
    ].join('\n');
    const rows = parseBacklogMd(md, 'x.md');
    expect(rows[0].priority).toBe('high');
    expect(rows[1].priority).toBe('medium');
    expect(rows[2].priority).toBe('low');
  });
});

describe('syncMarkdownToSqlite (reconciliation)', () => {
  let tmpDir: string;
  let mdFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-md-'));
    mdFile = path.join(tmpDir, 'todo.md');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('initial sync inserts all parsed rows', () => {
    fs.writeFileSync(mdFile, [
      '- [ ] **A**',
      '- [ ] **B**',
      '- [x] **C**',
    ].join('\n'));
    const db = makeDb();
    const r = syncMarkdownToSqlite(db, [mdFile]);
    expect(r.parsed).toBe(3);
    expect(r.inserted).toBe(3);
    expect(r.archived).toBe(0);

    const titles = (db.prepare(`SELECT title FROM tasks ORDER BY id`).all() as Array<{ title: string }>)
      .map((t) => t.title);
    expect(titles).toEqual(['A', 'B', 'C']);
  });

  it('second sync with no changes is a no-op', () => {
    fs.writeFileSync(mdFile, '- [ ] **A**\n');
    const db = makeDb();
    syncMarkdownToSqlite(db, [mdFile]);
    const r2 = syncMarkdownToSqlite(db, [mdFile]);
    expect(r2.inserted).toBe(0);
    expect(r2.archived).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  it('archives a SQLite row whose md line disappeared', () => {
    fs.writeFileSync(mdFile, ['- [ ] **A**', '- [ ] **B**'].join('\n'));
    const db = makeDb();
    syncMarkdownToSqlite(db, [mdFile]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL`).get() as { n: number }).n,
    ).toBe(2);

    // Remove B
    fs.writeFileSync(mdFile, '- [ ] **A**\n');
    const r = syncMarkdownToSqlite(db, [mdFile]);
    expect(r.archived).toBe(1);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL`).get() as { n: number }).n,
    ).toBe(1);
  });

  it('new md line in subsequent sync gets inserted', () => {
    fs.writeFileSync(mdFile, '- [ ] **A**\n');
    const db = makeDb();
    syncMarkdownToSqlite(db, [mdFile]);

    fs.writeFileSync(mdFile, ['- [ ] **A**', '- [ ] **NEW**'].join('\n'));
    const r = syncMarkdownToSqlite(db, [mdFile]);
    expect(r.inserted).toBe(1);
    expect(r.archived).toBe(0);
  });

  it('tolerates missing files (skips silently)', () => {
    const db = makeDb();
    const r = syncMarkdownToSqlite(db, [path.join(tmpDir, 'does-not-exist.md')]);
    expect(r.parsed).toBe(0);
    expect(r.inserted).toBe(0);
  });

  it('boardId scoping: syncing board B does NOT archive tasks on board A', () => {
    // Set up two boards in the same DB
    const db = makeDb();
    db.prepare(`INSERT INTO boards (slug, name) VALUES ('board-b', 'Board B')`).run();
    const boardA = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get('personal') as { id: number };
    const boardB = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get('board-b') as { id: number };

    // Insert a task on board A with an external_md_ref
    const mdA = path.join(tmpDir, 'todo-a.md');
    fs.writeFileSync(mdA, '- [ ] **Task on A**\n');
    syncMarkdownToSqlite(db, [mdA], { boardSlug: 'personal', boardId: boardA.id });

    // Confirm it's there
    const countA = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`).get(boardA.id) as { n: number }).n;
    expect(countA).toBe(1);

    // Now sync board B with a different file (no overlap in refs)
    const mdB = path.join(tmpDir, 'todo-b.md');
    fs.writeFileSync(mdB, '- [ ] **Task on B**\n');
    const r = syncMarkdownToSqlite(db, [mdB], { boardSlug: 'board-b', boardId: boardB.id });

    // Board B gets its task inserted
    expect(r.inserted).toBe(1);

    // Board A's task must NOT be archived even though its ref is not in B's seen set
    const stillActiveA = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`).get(boardA.id) as { n: number }).n;
    expect(stillActiveA).toBe(1);

    // Board B's task is active
    const activeB = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`).get(boardB.id) as { n: number }).n;
    expect(activeB).toBe(1);
  });

  it('boardId scoping: archives only stale tasks within the scoped board', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO boards (slug, name) VALUES ('board-b', 'Board B')`).run();
    const boardA = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get('personal') as { id: number };
    const boardB = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get('board-b') as { id: number };

    // Seed board A and board B with tasks
    const mdA = path.join(tmpDir, 'todo-a.md');
    fs.writeFileSync(mdA, ['- [ ] **Keep A**', '- [ ] **Drop A**'].join('\n'));
    syncMarkdownToSqlite(db, [mdA], { boardSlug: 'personal', boardId: boardA.id });

    const mdB = path.join(tmpDir, 'todo-b.md');
    fs.writeFileSync(mdB, '- [ ] **Keep B**\n');
    syncMarkdownToSqlite(db, [mdB], { boardSlug: 'board-b', boardId: boardB.id });

    // Now re-sync board B with an empty file — only board B tasks should be archived
    fs.writeFileSync(mdB, '');
    const r = syncMarkdownToSqlite(db, [mdB], { boardSlug: 'board-b', boardId: boardB.id });
    expect(r.archived).toBe(1);

    // Board A still has both tasks active
    const activeA = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`).get(boardA.id) as { n: number }).n;
    expect(activeA).toBe(2);

    // Board B has 0 active tasks
    const activeB = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`).get(boardB.id) as { n: number }).n;
    expect(activeB).toBe(0);
  });
});

describe('syncProjectMarkdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-proj-'));
    fs.mkdirSync(path.join(tmpDir, 'tasks'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('returns zero SyncResult when the project has no boards', () => {
    const db = makeFullDb();
    // Insert a project but no board for it
    db.prepare(`INSERT INTO projects (slug, name, root_path, position) VALUES ('orphan', 'Orphan', ?, 1)`).run(tmpDir);

    const r = syncProjectMarkdown(db, { slug: 'orphan', root_path: tmpDir });
    expect(r).toEqual({ parsed: 0, inserted: 0, archived: 0, unchanged: 0 });
  });

  it('reads tasks/todo.md from the project root_path into its first board', () => {
    const db = makeFullDb();

    // The 011 migration inserts a 'default' project and links existing boards to it.
    // Update default project root_path to our tmpDir so the sync reads from there.
    db.prepare(`UPDATE projects SET root_path = ? WHERE slug = 'default'`).run(tmpDir);

    // Write a todo.md in the temp tasks dir
    fs.writeFileSync(path.join(tmpDir, 'tasks', 'todo.md'), [
      '- [ ] **Alpha**',
      '- [ ] **Beta**',
    ].join('\n'));

    // The default project's board is the one inserted by 001_init (personal / Default).
    // Find the default project's first board.
    const defaultProject = db.prepare(`SELECT id, root_path FROM projects WHERE slug = 'default'`).get() as { id: number; root_path: string };
    expect(defaultProject.root_path).toBe(tmpDir);

    const r = syncProjectMarkdown(db, { slug: 'default', root_path: tmpDir });
    expect(r.inserted).toBe(2);
    expect(r.archived).toBe(0);

    // Confirm tasks landed in the DB
    const tasks = db.prepare(`SELECT title FROM tasks ORDER BY id`).all() as Array<{ title: string }>;
    expect(tasks.map((t) => t.title)).toEqual(['Alpha', 'Beta']);
  });

  it('is a no-op when tasks files do not exist', () => {
    const db = makeFullDb();
    db.prepare(`UPDATE projects SET root_path = ? WHERE slug = 'default'`).run(tmpDir);
    // No todo.md / backlog.md in tmpDir/tasks
    const r = syncProjectMarkdown(db, { slug: 'default', root_path: tmpDir });
    expect(r.inserted).toBe(0);
    expect(r.parsed).toBe(0);
  });

  it('scopes archive to the project board (cross-project safety)', () => {
    const db = makeFullDb();

    // Set up a second temp dir for a second project
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-proj2-'));
    fs.mkdirSync(path.join(tmpDir2, 'tasks'));
    try {
      // Create project-two with its own board
      db.prepare(`INSERT INTO projects (slug, name, root_path, position) VALUES ('proj-two', 'Project Two', ?, 2)`).run(tmpDir2);
      db.prepare(
        `INSERT INTO boards (slug, name, project_id)
         VALUES ('board-two', 'Board Two', (SELECT id FROM projects WHERE slug = 'proj-two'))`,
      ).run();

      const defaultBoard = db.prepare(
        `SELECT id FROM boards WHERE project_id = (SELECT id FROM projects WHERE slug = 'default') ORDER BY position, id LIMIT 1`,
      ).get() as { id: number };
      const boardTwo = db.prepare(`SELECT id FROM boards WHERE slug = 'board-two'`).get() as { id: number };

      // Directly seed tasks with distinct external_md_refs (avoids basename collision
      // between projects — both would use 'todo.md:N' which is an existing global-ref
      // limitation; the test is about archive scoping, not the insert path).
      db.prepare(
        `INSERT INTO tasks (board_id, title, status, external_md_ref) VALUES (?, 'D1', 'backlog', 'default/todo.md:1')`,
      ).run(defaultBoard.id);
      db.prepare(
        `INSERT INTO tasks (board_id, title, status, external_md_ref) VALUES (?, 'D2', 'backlog', 'default/todo.md:2')`,
      ).run(defaultBoard.id);
      db.prepare(
        `INSERT INTO tasks (board_id, title, status, external_md_ref) VALUES (?, 'P2', 'backlog', 'proj-two/todo.md:1')`,
      ).run(boardTwo.id);

      // Re-sync project-two with empty file — uses boardId scoping so only
      // proj-two/todo.md:1 should be archived.
      fs.writeFileSync(path.join(tmpDir2, 'tasks', 'todo.md'), '');
      // syncProjectMarkdown finds board-two (id=boardTwo.id) and syncs with boardId scope
      const r = syncProjectMarkdown(db, { slug: 'proj-two', root_path: tmpDir2 });
      expect(r.archived).toBe(1);

      // Default project's 2 tasks must remain active
      const activeDefault = (db.prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`,
      ).get(defaultBoard.id) as { n: number }).n;
      expect(activeDefault).toBe(2);

      // Project-two's task must be archived
      const activeTwo = (db.prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND archived_at IS NULL`,
      ).get(boardTwo.id) as { n: number }).n;
      expect(activeTwo).toBe(0);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
