// US-024 tests — prioritize-backlog agent (heuristics + LLM driver + apply).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runPrioritize, heuristicScore } from '../api/agents/prioritize_backlog';
import { runPendingMigrations } from '../db';
import { seedDefaults } from '../seed';
import type { ChatOptions, ChatResult } from '../llm';

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-prio-test-'));
  const db = new Database(path.join(dir, 'pm.db'));
  db.pragma('foreign_keys = ON');
  runPendingMigrations(db);
  seedDefaults(db);
  return db;
}

function personalBoardId(db: Database.Database): number {
  const row = db.prepare(`SELECT id FROM boards WHERE slug = 'personal' LIMIT 1`).get() as { id: number };
  return row.id;
}

interface SeedTaskOpts {
  title: string;
  priority?: string | null;
  due_date?: string | null;
  position?: number;
  blockers?: string | null;
  created_at_offset_days?: number;
}

function seedTask(db: Database.Database, board_id: number, t: SeedTaskOpts): number {
  const created_at = t.created_at_offset_days != null
    ? `datetime('now', '-${t.created_at_offset_days} days')`
    : `datetime('now')`;
  const r = db
    .prepare(
      `INSERT INTO tasks (board_id, title, status, priority, due_date, position, blockers, created_at)
       VALUES (?, ?, 'backlog', ?, ?, ?, ?, ${created_at})`,
    )
    .run(board_id, t.title, t.priority ?? null, t.due_date ?? null, t.position ?? 0, t.blockers ?? null);
  return r.lastInsertRowid as number;
}

// A deterministic mock that always returns heuristic order reversed —
// proves the LLM ordering path wins over heuristic when it succeeds.
function makeLlmReversingMock(): jest.Mock<Promise<ChatResult>, [ChatOptions]> {
  return jest.fn(async (opts: ChatOptions) => {
    const userMsg = opts.messages.find((m) => m.role === 'user')?.content ?? '';
    const ids = Array.from(userMsg.matchAll(/^#(\d+)/gm)).map((m) => Number(m[1]));
    const reversed = ids.slice().reverse();
    const ranking = reversed.map((id) => ({ task_id: id, rationale: `mock rationale ${id}` }));
    return { reply: JSON.stringify({ ranking }), usage: { input_tokens: 0, output_tokens: 0 } };
  });
}

describe('heuristicScore', () => {
  const now = new Date('2026-05-27T12:00:00Z');
  const ctx = { now, blockersOfOthers: new Set<number>(), recentErrorTaskIds: new Set<number>() };

  test('higher priority beats lower priority, all else equal', () => {
    const hi = { id: 1, title: 'a', status: 'backlog', priority: 'high', due_date: null,
      effort_hours: null, position: 0, blockers: null, created_at: '2026-05-20', epic_id: null };
    const lo = { ...hi, id: 2, priority: 'low' as string };
    expect(heuristicScore(hi, ctx)).toBeGreaterThan(heuristicScore(lo, ctx));
  });

  test('overdue dominates priority weight', () => {
    const overdueLow = { id: 1, title: 'a', status: 'backlog', priority: 'low', due_date: '2026-05-20',
      effort_hours: null, position: 0, blockers: null, created_at: '2026-05-01', epic_id: null };
    const futureHigh = { ...overdueLow, id: 2, priority: 'high' as string, due_date: '2026-12-01' };
    expect(heuristicScore(overdueLow, ctx)).toBeGreaterThan(heuristicScore(futureHigh, ctx));
  });

  test('unblock-others bonus stacks on top of priority', () => {
    const unblockerMed = { id: 1, title: 'a', status: 'backlog', priority: 'medium', due_date: null,
      effort_hours: null, position: 0, blockers: null, created_at: '2026-05-25', epic_id: null };
    const plainMed = { ...unblockerMed, id: 2 };
    const ctxWith = { ...ctx, blockersOfOthers: new Set<number>([1]) };
    expect(heuristicScore(unblockerMed, ctxWith)).toBeGreaterThan(heuristicScore(plainMed, ctxWith));
  });
});

describe('runPrioritize - US-024', () => {
  test('empty board: skipped agent_run, no proposals, no error', async () => {
    const db = freshDb();
    try {
      const res = await runPrioritize(db, personalBoardId(db), {});
      expect(res.proposals).toEqual([]);
      expect(res.applied).toBe(false);
      expect(res.llm_used).toBe(false);

      const run = db.prepare(`SELECT status, notes FROM agent_runs WHERE id = ?`).get(res.agent_run_id) as { status: string; notes: string };
      expect(run.status).toBe('skipped');
      expect(run.notes).toMatch(/no open tasks/);
    } finally {
      db.close();
    }
  });

  test('dry-run with heuristic-only (no LLM): proposes order, DB positions unchanged', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      const idLow = seedTask(db, bid, { title: 'low pri', priority: 'low', position: 0 });
      const idHigh = seedTask(db, bid, { title: 'high pri', priority: 'high', position: 1 });
      const idMed = seedTask(db, bid, { title: 'med pri', priority: 'medium', position: 2 });

      const llm = jest.fn(async () => { throw new Error('no network'); }) as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { llm });
      expect(res.applied).toBe(false);
      expect(res.llm_used).toBe(false);
      expect(res.proposals).toHaveLength(3);
      expect(res.proposals[0].task_id).toBe(idHigh);
      expect(res.proposals[1].task_id).toBe(idMed);
      expect(res.proposals[2].task_id).toBe(idLow);

      const positions = db.prepare(`SELECT id, position FROM tasks WHERE board_id = ? ORDER BY id`).all(bid) as Array<{ id: number; position: number }>;
      expect(positions.find((p) => p.id === idLow)?.position).toBe(0);
      expect(positions.find((p) => p.id === idHigh)?.position).toBe(1);

      const run = db.prepare(`SELECT status, notes FROM agent_runs WHERE id = ?`).get(res.agent_run_id) as { status: string; notes: string };
      expect(run.status).toBe('error');
      expect(run.notes).toMatch(/LLM call failed.*no network/);
    } finally {
      db.close();
    }
  });

  test('apply: positions written in transaction; agent_run logs action=apply', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      const idA = seedTask(db, bid, { title: 'A', priority: 'low', position: 0 });
      const idB = seedTask(db, bid, { title: 'B', priority: 'high', position: 1 });

      const llm = jest.fn(async () => { throw new Error('skip'); }) as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { apply: true, llm });
      expect(res.applied).toBe(true);

      const after = db.prepare(`SELECT id, position FROM tasks WHERE board_id = ? ORDER BY position ASC`).all(bid) as Array<{ id: number; position: number }>;
      expect(after[0].id).toBe(idB);
      expect(after[0].position).toBe(0);
      expect(after[1].id).toBe(idA);
      expect(after[1].position).toBe(1);

      const run = db.prepare(`SELECT notes FROM agent_runs WHERE id = ?`).get(res.agent_run_id) as { notes: string };
      expect(run.notes).toMatch(/action=apply/);
    } finally {
      db.close();
    }
  });

  test('LLM success overrides heuristic ordering + per-task rationales attached', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      const idA = seedTask(db, bid, { title: 'A', priority: 'high' });
      const idB = seedTask(db, bid, { title: 'B', priority: 'high' });
      const idC = seedTask(db, bid, { title: 'C', priority: 'high' });

      const llm = makeLlmReversingMock() as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { llm });
      expect(res.llm_used).toBe(true);
      expect(res.proposals).toHaveLength(3);
      // Mock reverses the prompt order (which mirrors heuristic order); for
      // 3 equal-priority tasks, heuristic preserves seed order → reversed
      // gives [C, B, A].
      expect(res.proposals.map((p) => p.task_id)).toEqual([idC, idB, idA]);
      expect(res.proposals[0].rationale).toBe(`mock rationale ${idC}`);
    } finally {
      db.close();
    }
  });

  test('LLM with wrong-shape reply falls back to heuristic, agent_run notes fallback', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      seedTask(db, bid, { title: 'X', priority: 'low' });
      seedTask(db, bid, { title: 'Y', priority: 'high' });

      const llm = jest.fn(async () => ({
        reply: 'not json at all',
        usage: { input_tokens: 0, output_tokens: 0 },
      })) as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { llm });
      expect(res.llm_used).toBe(false);
      const run = db.prepare(`SELECT notes FROM agent_runs WHERE id = ?`).get(res.agent_run_id) as { notes: string };
      expect(run.notes).toMatch(/non-JSON or wrong shape/);
    } finally {
      db.close();
    }
  });

  test('LLM ranking missing a task id falls back to heuristic', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      const idA = seedTask(db, bid, { title: 'A', priority: 'high' });
      seedTask(db, bid, { title: 'B', priority: 'low' });

      const llm = jest.fn(async () => ({
        // Only one of two ids — wrong shape, should trigger fallback.
        reply: JSON.stringify({ ranking: [{ task_id: idA, rationale: 'only one' }] }),
        usage: { input_tokens: 0, output_tokens: 0 },
      })) as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { llm });
      expect(res.llm_used).toBe(false);
      const run = db.prepare(`SELECT notes FROM agent_runs WHERE id = ?`).get(res.agent_run_id) as { notes: string };
      expect(run.notes).toMatch(/covered 1\/2 ids/);
    } finally {
      db.close();
    }
  });

  test('rejects unknown board_id with 404-shaped error', async () => {
    const db = freshDb();
    try {
      await expect(runPrioritize(db, 9999, {})).rejects.toThrow(/board 9999 not found/);
    } finally {
      db.close();
    }
  });

  test('rejects invalid board_id with VALIDATION error', async () => {
    const db = freshDb();
    try {
      await expect(runPrioritize(db, 0, {})).rejects.toThrow(/board_id required/);
      await expect(runPrioritize(db, NaN, {})).rejects.toThrow(/board_id required/);
    } finally {
      db.close();
    }
  });

  test('unblock-others bumps task referenced in another task blockers field', async () => {
    const db = freshDb();
    try {
      const bid = personalBoardId(db);
      const idUnblocker = seedTask(db, bid, { title: 'unblocker', priority: 'low', position: 0 });
      seedTask(db, bid, { title: 'waiter', priority: 'low', position: 1, blockers: `blocked on #${idUnblocker}` });

      const llm = jest.fn(async () => { throw new Error('skip'); }) as unknown as typeof import('../llm').chat;

      const res = await runPrioritize(db, bid, { llm });
      // unblocker should sit first despite identical low priority — the
      // +25 unblock-others bump dominates.
      expect(res.proposals[0].task_id).toBe(idUnblocker);
    } finally {
      db.close();
    }
  });
});
