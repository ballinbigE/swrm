// Tests for sync_md parser + reconciler.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { parseBacklogMd, syncMarkdownToSqlite } from '../sync_md';

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
});
