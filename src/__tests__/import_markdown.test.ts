// US-038 tests - one-shot markdown to SQLite import.
//
// Builds a self-contained schema mirroring the canonical US-001 shape so
// this test is not gated on sibling-track migrations landing first. The
// columns selected/inserted in runImport() are the contract: if the real
// US-001 schema drifts from this skeleton the import will break and we want
// THIS test to be the canary.

import Database from 'better-sqlite3';

import { runImport } from '../import_markdown';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE epics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      color TEXT,
      target_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      epic_id INTEGER REFERENCES epics(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      position INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      effort_hours REAL,
      due_date TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`INSERT INTO boards (name, position) VALUES ('Personal', 0)`).run();
  db.prepare(`INSERT INTO boards (name, position) VALUES ('AI Agent Tasks', 1)`).run();
  db.prepare(`INSERT INTO boards (name, position) VALUES ('Work', 2)`).run();
  return db;
}

const FIXTURE_BACKLOG = `# Backlog

## L741 - Perf / Observability Polish

Open carry-overs only:

### L741-US-023 - Contacts-pagination perf verify

- **Status:** ready (unblocked 2026-05-26 PM by US-011)
- **Priority:** P2 - **Effort:** 0.5
- **Surface:** Probe perf data + document delta.

### L184-US-001 - Restore Slack firehose export

- **Status:** rep-action (needs new webhook URL)
- **Priority:** P1 - **Effort:** 0.5
- **Surface:** nugget to signal-firehose disabled 2026-04-30.

### L729-US-001 - Test backfill: pure helpers

- **Status:** blocked on parallel agent
- **Priority:** P1 - **Effort:** 2
- **Surface:** 15 untested helpers identified.
`;

const FIXTURE_SHIPPED = `# Shipped

## 2026-05-26 - batch

### L744-US-001 - Compose-screen redesign sim verify

- **Status:** shipped 2026-05-26
- **Priority:** P1 - **Effort:** 1
- **Surface:** Verified on iPhone 17 Pro sim.

### L731-a - parseVoice first-person rep extractor

- **Status:** shipped 2026-05-26
- **Priority:** ? - **Effort:** 0.5
- **Surface:** rep_self_patches JSON now flows.
`;

const FIXTURE_TODO = `# todo

## Active

- [ ] First open todo line
- [x] Already-closed line should be skipped
`;

const FIXTURE_EPICS = `# Epics

| File | L# | Status | Started | One-liner |
|---|---|---|---|---|
| \`L616-healpay.md\` | L616 | open | (TBD) | Library |
| \`README.md\` | - | - | - | (skipped) |
`;

describe('runImport - US-038', () => {
  test('dry-run is a no-op: zero rows written, counts populated', () => {
    const db = freshDb();
    try {
      const result = runImport(
        db,
        { todo: FIXTURE_TODO, backlog: FIXTURE_BACKLOG, shipped: FIXTURE_SHIPPED, epicsReadme: FIXTURE_EPICS },
        {},
      );
      expect(result.dry_run).toBe(true);
      // 3 backlog rows (L741-US-023, L184, L729) + 2 shipped (L744-US-001, L731-a) + 1 open todo = 6 task candidates.
      expect(result.tasks.created).toBe(6);
      expect(result.tasks.updated).toBe(0);
      // Epics: L616 (from README) + L741 (bare `## L741` backlog header, now
      // surfaced by the synth-status parser fix — header-only rows default
      // to status='open' so the epic-shaped id survives the filter).
      expect(result.epics.created).toBe(2);

      // No rows actually written.
      const taskCount = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
      const epicCount = (db.prepare(`SELECT COUNT(*) AS n FROM epics`).get() as { n: number }).n;
      expect(taskCount).toBe(0);
      expect(epicCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test('apply: 6 task rows written w/ correct status mapping', () => {
    const db = freshDb();
    try {
      const result = runImport(
        db,
        { todo: FIXTURE_TODO, backlog: FIXTURE_BACKLOG, shipped: FIXTURE_SHIPPED, epicsReadme: FIXTURE_EPICS },
        { apply: true },
      );
      expect(result.dry_run).toBe(false);
      expect(result.tasks.created).toBe(6);

      const tasks = db
        .prepare(`SELECT title, status, priority FROM tasks ORDER BY id ASC`)
        .all() as Array<{ title: string; status: string; priority: string | null }>;
      expect(tasks).toHaveLength(6);

      const byTitle = new Map(tasks.map((t) => [t.title, t]));

      // backlog row 1 - ready -> todo
      const r1 = byTitle.get('Contacts-pagination perf verify');
      expect(r1).toBeDefined();
      expect(r1!.status).toBe('todo');
      expect(r1!.priority).toBe('med'); // P2

      // backlog row 2 - rep-action -> backlog (rep-action does not match any "ready" prefix)
      const r2 = byTitle.get('Restore Slack firehose export');
      expect(r2).toBeDefined();
      expect(r2!.status).toBe('backlog');
      expect(r2!.priority).toBe('high'); // P1

      // backlog row 3 - blocked -> backlog
      const r3 = byTitle.get('Test backfill: pure helpers');
      expect(r3).toBeDefined();
      expect(r3!.status).toBe('backlog');

      // shipped row 1 -> done
      const s1 = byTitle.get('Compose-screen redesign sim verify');
      expect(s1).toBeDefined();
      expect(s1!.status).toBe('done');

      // shipped row 2 -> done (priority "?" stays null)
      const s2 = byTitle.get('parseVoice first-person rep extractor');
      expect(s2).toBeDefined();
      expect(s2!.status).toBe('done');
      expect(s2!.priority).toBeNull();

      // open todo -> todo
      const t1 = byTitle.get('First open todo line');
      expect(t1).toBeDefined();
      expect(t1!.status).toBe('todo');

      // closed todo NOT imported
      expect(byTitle.has('Already-closed line should be skipped')).toBe(false);

      // epics - 2 created (L616 from README + L741 from backlog header)
      const epicCount = (db.prepare(`SELECT COUNT(*) AS n FROM epics`).get() as { n: number }).n;
      expect(epicCount).toBe(2);
    } finally {
      db.close();
    }
  });

  test('idempotent: re-running apply does NOT duplicate (updates instead)', () => {
    const db = freshDb();
    try {
      runImport(db, { todo: FIXTURE_TODO, backlog: FIXTURE_BACKLOG, shipped: FIXTURE_SHIPPED, epicsReadme: FIXTURE_EPICS }, { apply: true });
      const result2 = runImport(
        db,
        { todo: FIXTURE_TODO, backlog: FIXTURE_BACKLOG, shipped: FIXTURE_SHIPPED, epicsReadme: FIXTURE_EPICS },
        { apply: true },
      );
      expect(result2.tasks.created).toBe(0);
      expect(result2.tasks.updated).toBe(6);
      expect(result2.epics.created).toBe(0);
      expect(result2.epics.updated).toBe(2);

      const taskCount = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
      expect(taskCount).toBe(6);
    } finally {
      db.close();
    }
  });

  test('bails w/ readable error when schema missing', () => {
    const db = new Database(':memory:');
    try {
      expect(() =>
        runImport(db, { todo: '', backlog: '', shipped: '', epicsReadme: '' }, {}),
      ).toThrow(/required table "boards" missing/);
    } finally {
      db.close();
    }
  });
});
