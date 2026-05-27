// US-025 tests — bug-fix agent ticket-filer.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { ingestErrorSamples, inferPriority, signatureFor, type ErrorSample } from '../api/agents/bug_fix';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bugfix-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

function makeSample(over: Partial<ErrorSample> = {}): ErrorSample {
  return {
    message: 'TypeError: Cannot read properties of undefined (reading foo)',
    stack: '    at handleClick (app/contacts/index.tsx:170:5)\n    at onPress',
    source: 'pm.log',
    occurred_at: '2026-05-27T10:00:00Z',
    ...over,
  };
}

describe('signatureFor', () => {
  test('same bug different timestamps collapses to one signature', () => {
    const a = makeSample({ message: 'TypeError: x is undefined at line 42' });
    const b = makeSample({ message: 'TypeError: x is undefined at line 99' });
    expect(signatureFor(a)).toBe(signatureFor(b));
  });

  test('different stack top frame → different signature', () => {
    const a = makeSample({ stack: '    at handleClick (app/contacts/index.tsx:170:5)' });
    const b = makeSample({ stack: '    at handleSubmit (app/compose/index.tsx:42:1)' });
    expect(signatureFor(a)).not.toBe(signatureFor(b));
  });

  test('uuids + hex normalized', () => {
    const a = makeSample({ message: 'Failed for 550e8400-e29b-41d4-a716-446655440000' });
    const b = makeSample({ message: 'Failed for 6ba7b810-9dad-11d1-80b4-00c04fd430c8' });
    expect(signatureFor(a)).toBe(signatureFor(b));
  });
});

describe('inferPriority', () => {
  test.each<[string, 'high' | 'medium' | 'low']>([
    ['app crashed unexpectedly', 'high'],
    ['unauthorized request', 'high'],
    ['data loss detected during sync', 'high'],
    ['OOM killed worker', 'high'],
    ['render failed for ContactCard', 'medium'],
    ['fetch failed: network error', 'medium'],
    ['blank screen on login', 'medium'],
    ['debug: ignored stale heartbeat', 'low'],
    ['warning: deprecated api', 'low'],
  ])('classifies "%s" as %s', (msg, expected) => {
    expect(inferPriority({ message: msg })).toBe(expected);
  });
});

describe('ingestErrorSamples - US-025', () => {
  test('3 samples same signature → 1 ticket, samples_count=3', () => {
    const db = freshDb();
    try {
      const samples = [makeSample(), makeSample(), makeSample()];
      const res = ingestErrorSamples(db, samples);
      expect(res.signatures_seen).toBe(1);
      expect(res.tickets_created).toBe(1);
      expect(res.tickets_updated).toBe(0);
      expect(res.details[0].samples_count).toBe(3);

      const row = db.prepare(`SELECT samples_count FROM tasks WHERE id = ?`).get(res.details[0].task_id) as { samples_count: number };
      expect(row.samples_count).toBe(3);
    } finally {
      db.close();
    }
  });

  test('subsequent ingest bumps existing samples_count, never dupes', () => {
    const db = freshDb();
    try {
      ingestErrorSamples(db, [makeSample(), makeSample()]);
      const after2 = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
      expect(after2).toBe(1);

      const res2 = ingestErrorSamples(db, [makeSample()]);
      expect(res2.tickets_created).toBe(0);
      expect(res2.tickets_updated).toBe(1);
      expect(res2.details[0].samples_count).toBe(3);

      const taskCount = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
      expect(taskCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test('label "bug" attached to created task via task_labels join', () => {
    const db = freshDb();
    try {
      const res = ingestErrorSamples(db, [makeSample()]);
      const labels = db
        .prepare(
          `SELECT l.name FROM labels l
             JOIN task_labels tl ON tl.label_id = l.id
            WHERE tl.task_id = ?`,
        )
        .all(res.details[0].task_id) as Array<{ name: string }>;
      expect(labels.map((l) => l.name)).toContain('bug');
    } finally {
      db.close();
    }
  });

  test('priority inferred from message: crash → high', () => {
    const db = freshDb();
    try {
      const res = ingestErrorSamples(db, [makeSample({ message: 'app crashed at startup' })]);
      const row = db.prepare(`SELECT priority FROM tasks WHERE id = ?`).get(res.details[0].task_id) as { priority: string };
      expect(row.priority).toBe('high');
    } finally {
      db.close();
    }
  });

  test('lands on AI Agent Tasks board', () => {
    const db = freshDb();
    try {
      const res = ingestErrorSamples(db, [makeSample()]);
      const row = db
        .prepare(
          `SELECT b.slug FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`,
        )
        .get(res.details[0].task_id) as { slug: string };
      expect(row.slug).toBe('ai-agent-tasks');
    } finally {
      db.close();
    }
  });

  test('writes ONE agent_runs row per ingest call regardless of sample count', () => {
    const db = freshDb();
    try {
      ingestErrorSamples(db, [makeSample(), makeSample(), makeSample(), makeSample()]);
      const runs = (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE agent_name = 'bug_fix'`).get() as { n: number }).n;
      expect(runs).toBe(1);

      ingestErrorSamples(db, [makeSample()]);
      const runs2 = (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE agent_name = 'bug_fix'`).get() as { n: number }).n;
      expect(runs2).toBe(2);
    } finally {
      db.close();
    }
  });

  test('two distinct signatures → two tickets', () => {
    const db = freshDb();
    try {
      const a = makeSample({ message: 'crash A', stack: 'at fn-a (file-a.ts:1)' });
      const b = makeSample({ message: 'crash B', stack: 'at fn-b (file-b.ts:1)' });
      const res = ingestErrorSamples(db, [a, a, b]);
      expect(res.signatures_seen).toBe(2);
      expect(res.tickets_created).toBe(2);
    } finally {
      db.close();
    }
  });
});
