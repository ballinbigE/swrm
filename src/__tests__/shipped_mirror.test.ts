// US-024 follow-up — DB closures mirrored to tasks/shipped.md so the
// rep-facing markdown dashboard reflects API-driven done/archived events.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { archiveTask, createTask, updateTask } from '../api/tasks';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';
import { mirrorClosure } from '../shipped_mirror';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mirror-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

function freshMd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mirror-md-'));
  const file = path.join(dir, 'shipped.md');
  fs.writeFileSync(file, '# Shipped — demo-project\n\nNewest first.\n\n## 2026-05-26 — prior session\n\n### L100 — earlier row\n\n- **Status:** shipped 2026-05-26\n', 'utf8');
  return file;
}

describe('mirrorClosure (direct)', () => {
  const ORIGINAL = process.env.PM_SHIPPED_MD_PATH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PM_SHIPPED_MD_PATH;
    else process.env.PM_SHIPPED_MD_PATH = ORIGINAL;
  });

  test('no-op when PM_SHIPPED_MD_PATH unset', () => {
    delete process.env.PM_SHIPPED_MD_PATH;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'x' });
      const r = mirrorClosure(db, t.id, 'status_done');
      expect(r.mirrored).toBe(false);
      expect(r.reason).toMatch(/unset/);
    } finally { db.close(); }
  });

  test('first closure today: inserts new "## YYYY-MM-DD — PM Dashboard auto-close" section + row', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'rep-facing close' });
      const r = mirrorClosure(db, t.id, 'status_done');
      expect(r.mirrored).toBe(true);
      const body = fs.readFileSync(md, 'utf8');
      expect(body).toMatch(/PM Dashboard auto-close/);
      expect(body).toMatch(new RegExp(`pm:T${t.id}`));
      expect(body).toMatch(/rep-facing close/);
      // Manual-section row preserved untouched.
      expect(body).toMatch(/L100 — earlier row/);
    } finally { db.close(); }
  });

  test('second closure same day: appends under the existing today section, no duplicate header', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const a = createTask(db, { title: 'first close' });
      const b = createTask(db, { title: 'second close' });
      mirrorClosure(db, a.id, 'status_done');
      mirrorClosure(db, b.id, 'archived');
      const body = fs.readFileSync(md, 'utf8');
      const headerCount = (body.match(/PM Dashboard auto-close/g) ?? []).length;
      expect(headerCount).toBe(1);
      expect(body).toMatch(new RegExp(`pm:T${a.id}`));
      expect(body).toMatch(new RegExp(`pm:T${b.id}`));
    } finally { db.close(); }
  });

  test('idempotent: re-mirror same task is no-op', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'once only' });
      const r1 = mirrorClosure(db, t.id, 'status_done');
      expect(r1.mirrored).toBe(true);
      const r2 = mirrorClosure(db, t.id, 'archived');
      expect(r2.mirrored).toBe(false);
      expect(r2.reason).toMatch(/already mirrored/);
      const body = fs.readFileSync(md, 'utf8');
      const occurrences = (body.match(new RegExp(`pm:T${t.id}`, 'g')) ?? []).length;
      expect(occurrences).toBe(1);
    } finally { db.close(); }
  });
});

describe('updateTask + archiveTask auto-mirror', () => {
  const ORIGINAL = process.env.PM_SHIPPED_MD_PATH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PM_SHIPPED_MD_PATH;
    else process.env.PM_SHIPPED_MD_PATH = ORIGINAL;
  });

  test('PATCH status=done fires mirror when env set', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'flip me' });
      const ok = updateTask(db, t.id, { status: 'done' });
      expect(ok).toBe(true);
      const body = fs.readFileSync(md, 'utf8');
      expect(body).toMatch(new RegExp(`pm:T${t.id}`));
    } finally { db.close(); }
  });

  test('PATCH non-status update does NOT fire mirror', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'just rename' });
      updateTask(db, t.id, { title: 'renamed' });
      const body = fs.readFileSync(md, 'utf8');
      expect(body).not.toMatch(new RegExp(`pm:T${t.id}`));
    } finally { db.close(); }
  });

  test('DELETE archive fires mirror (reason=archived)', () => {
    const md = freshMd();
    process.env.PM_SHIPPED_MD_PATH = md;
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'archive me' });
      const ok = archiveTask(db, t.id);
      expect(ok).toBe(true);
      const body = fs.readFileSync(md, 'utf8');
      expect(body).toMatch(/via PM API — archived/);
    } finally { db.close(); }
  });

  test('mirror failure does not break DB update', () => {
    process.env.PM_SHIPPED_MD_PATH = '/nonexistent-dir/no/such.md';
    const db = freshDb();
    try {
      const t = createTask(db, { title: 'survives mirror error' });
      const ok = updateTask(db, t.id, { status: 'done' });
      expect(ok).toBe(true);
      const row = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(t.id) as { status: string };
      expect(row.status).toBe('done');
    } finally { db.close(); }
  });
});
