// US-007 — in-process orchestrator: due-selection, single-flight, catch-up, stale-lock reset.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { resetStaleRunning, tickOnce } from '../orchestrator';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

interface InsertOpts {
  enabled?: number;
  next_due?: string | null;
  last_status?: string;
  frequency?: string;
  timeout?: number;
  updated_at?: string;
}

function insert(db: Database.Database, name: string, o: InsertOpts = {}): number {
  const r = db.prepare(
    `INSERT INTO skills (name, project, type, frequency, side_effects, command, enabled, next_due, last_status, timeout, updated_at)
     VALUES (?, 'p', 'command', ?, 'read-only', 'echo x', ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    name,
    o.frequency ?? '1h',
    o.enabled ?? 1,
    o.next_due === undefined ? null : o.next_due,
    o.last_status ?? 'idle',
    o.timeout ?? 600,
    o.updated_at ?? null,
  );
  return r.lastInsertRowid as number;
}

const NOW = new Date(2026, 4, 27, 12, 0, 0);
const PAST = new Date(2026, 4, 27, 11, 0, 0).toISOString();
const FUTURE = new Date(2026, 4, 27, 13, 0, 0).toISOString();

function okRunner() {
  const calls: number[] = [];
  const runner = async (_db: Database.Database, s: { id: number }) => {
    calls.push(s.id);
    return { status: 'ok' as const };
  };
  return { runner, calls };
}

describe('tickOnce (US-007)', () => {
  it('runs a due skill and advances next_due into the future', async () => {
    const db = makeDb();
    const id = insert(db, 'due', { next_due: PAST });
    const { runner, calls } = okRunner();
    const r = await tickOnce(db, { now: NOW, runner });
    expect(r.ran).toBe(1);
    expect(calls).toEqual([id]);
    const row = db.prepare(`SELECT last_status, next_due, last_run FROM skills WHERE id = ?`).get(id) as Record<string, string>;
    expect(row.last_status).toBe('ok');
    expect(row.last_run).toBeTruthy();
    expect(new Date(row.next_due).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('skips a skill that is not due yet', async () => {
    const db = makeDb();
    insert(db, 'future', { next_due: FUTURE });
    const { runner, calls } = okRunner();
    const r = await tickOnce(db, { now: NOW, runner });
    expect(r.ran).toBe(0);
    expect(calls).toEqual([]);
  });

  it('skips a paused (enabled=0) skill', async () => {
    const db = makeDb();
    insert(db, 'paused', { next_due: PAST, enabled: 0 });
    const { runner } = okRunner();
    expect((await tickOnce(db, { now: NOW, runner })).ran).toBe(0);
  });

  it('treats NULL next_due as due (new skill runs)', async () => {
    const db = makeDb();
    insert(db, 'fresh', { next_due: null });
    const { runner, calls } = okRunner();
    await tickOnce(db, { now: NOW, runner });
    expect(calls).toHaveLength(1);
  });

  it('does not run a skill already marked running (single-flight)', async () => {
    const db = makeDb();
    insert(db, 'busy', { next_due: PAST, last_status: 'running' });
    const { runner, calls } = okRunner();
    expect((await tickOnce(db, { now: NOW, runner })).ran).toBe(0);
    expect(calls).toEqual([]);
  });

  it('collapses a far-past next_due into a single catch-up run', async () => {
    const db = makeDb();
    const id = insert(db, 'missed', { next_due: new Date(2026, 0, 1).toISOString(), frequency: '1h' });
    const { runner, calls } = okRunner();
    await tickOnce(db, { now: NOW, runner });
    expect(calls).toEqual([id]); // ran once, not N times
    const row = db.prepare(`SELECT next_due FROM skills WHERE id = ?`).get(id) as { next_due: string };
    expect(new Date(row.next_due).getTime()).toBeGreaterThan(NOW.getTime()); // rescheduled from now
  });

  it('records error status when the runner throws, still advances schedule', async () => {
    const db = makeDb();
    const id = insert(db, 'boom', { next_due: PAST });
    const runner = async () => { throw new Error('kaboom'); };
    await tickOnce(db, { now: NOW, runner });
    const row = db.prepare(`SELECT last_status, next_due FROM skills WHERE id = ?`).get(id) as Record<string, string>;
    expect(row.last_status).toBe('error');
    expect(new Date(row.next_due).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('resetStaleRunning (US-007)', () => {
  it('resets a stale running lock to error but leaves a fresh one', () => {
    const db = makeDb();
    const stale = insert(db, 'stale', { last_status: 'running', timeout: 600, updated_at: '2020-01-01 00:00:00' });
    const fresh = insert(db, 'fresh', { last_status: 'running', timeout: 600 });
    resetStaleRunning(db, new Date());
    expect((db.prepare(`SELECT last_status FROM skills WHERE id = ?`).get(stale) as { last_status: string }).last_status).toBe('error');
    expect((db.prepare(`SELECT last_status FROM skills WHERE id = ?`).get(fresh) as { last_status: string }).last_status).toBe('running');
  });
});
