// swrm/src/skills/orchestrator.ts — in-process scheduler for Skill Cards.
//
// startOrchestrator() runs a tick on an interval while the server is up.
// Each tick selects due skills (enabled, not running, next_due past/null),
// claims each with a single-flight lock, runs it, then reschedules from `now`
// — so a server that was down doesn't fire a burst of catch-up runs.
//
// next_due is authoritative + persisted; the tick interval is only resolution.

import type Database from 'better-sqlite3';

import { runAgentSkill } from './agent';
import { runCommandSkill } from './executor';
import { nextDue } from './schedule';
import { syncSkillsDir } from './sync';

export interface SkillRow {
  id: number;
  name: string;
  project: string;
  type: string;
  agent: string | null;
  mcp: string | null;
  command: string | null;
  timeout: number;
  file_path: string | null;
  needs_worktree: number;
  frequency: string;
}

export type SkillRunner = (
  db: Database.Database,
  skill: SkillRow,
  opts: { cwd?: string },
) => Promise<{ status: 'ok' | 'error' }>;

export interface TickOpts {
  now?: Date;
  runner?: SkillRunner;
  /** Resolve the working dir for a skill (e.g. its project repo / worktree). */
  cwdFor?: (skill: SkillRow) => string | undefined;
  /** If set, re-sync this skills dir into the DB at the start of each tick so
   *  new/edited *.skill.md cards appear without a server restart. */
  syncDir?: string;
}

export interface TickResult {
  ran: number;
}

function sqlNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Dispatch a skill to its executor by type. The default SkillRunner. */
export const dispatchSkill: SkillRunner = async (db, s, opts) => {
  if (s.type === 'agent') {
    const r = await runAgentSkill(
      db,
      {
        id: s.id,
        name: s.name,
        agent: s.agent,
        mcp: JSON.parse(s.mcp ?? '[]') as string[],
        timeout: s.timeout,
        file_path: s.file_path,
        needs_worktree: s.needs_worktree === 1,
      },
      { cwd: opts.cwd },
    );
    return { status: r.status };
  }
  const r = await runCommandSkill(
    db,
    { id: s.id, name: s.name, command: s.command, timeout: s.timeout, file_path: s.file_path },
    { cwd: opts.cwd },
  );
  return { status: r.status };
};

/**
 * Run one skill: claim the single-flight lock, dispatch, then reschedule from
 * `now`. Returns {skipped:true} if the lock was already held. Shared by the
 * tick (US-007) and "run now" (US-008) so scheduling state is written one way.
 * Does NOT check due-ness — callers decide that (run-now forces a run).
 */
export async function runSkillRow(
  db: Database.Database,
  s: SkillRow,
  opts: TickOpts = {},
): Promise<{ status: 'ok' | 'error' } | { skipped: true }> {
  const now = opts.now ?? new Date();
  const runner = opts.runner ?? dispatchSkill;

  const claimed = db
    .prepare(`UPDATE skills SET last_status = 'running', updated_at = ? WHERE id = ? AND last_status != 'running'`)
    .run(sqlNow(now), s.id);
  if (claimed.changes === 0) return { skipped: true };

  let status: 'ok' | 'error' = 'error';
  try {
    status = (await runner(db, s, { cwd: opts.cwdFor?.(s) })).status;
  } catch {
    status = 'error';
  }

  // Reschedule from `now` (not the stale next_due) to collapse missed runs.
  const next = nextDue(s.frequency, now, now).toISOString();
  db.prepare(`UPDATE skills SET last_status = ?, last_run = ?, next_due = ?, updated_at = ? WHERE id = ?`)
    .run(status, now.toISOString(), next, sqlNow(now), s.id);
  return { status };
}

export async function tickOnce(db: Database.Database, opts: TickOpts = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();

  // Pick up new/edited cards each tick (non-fatal on parse/read error).
  if (opts.syncDir) {
    try {
      syncSkillsDir(db, opts.syncDir);
    } catch {
      /* a bad card shouldn't stop scheduled runs; surfaced at next manual sync */
    }
  }

  const due = db
    .prepare(
      `SELECT * FROM skills
       WHERE enabled = 1 AND last_status != 'running' AND (next_due IS NULL OR next_due <= ?)`,
    )
    .all(now.toISOString()) as SkillRow[];

  let ran = 0;
  for (const s of due) {
    const r = await runSkillRow(db, s, opts);
    if (!('skipped' in r)) ran += 1;
  }
  return { ran };
}

/** On boot, clear single-flight locks left 'running' by a crash past their timeout. */
export function resetStaleRunning(db: Database.Database, now: Date): void {
  const running = db
    .prepare(`SELECT id, updated_at, timeout FROM skills WHERE last_status = 'running'`)
    .all() as Array<{ id: number; updated_at: string; timeout: number }>;
  const reset = db.prepare(`UPDATE skills SET last_status = 'error', updated_at = ? WHERE id = ?`);
  for (const s of running) {
    const updatedMs = Date.parse(`${s.updated_at.replace(' ', 'T')}Z`);
    if (Number.isNaN(updatedMs)) continue;
    if (now.getTime() - updatedMs > s.timeout * 1000) reset.run(sqlNow(now), s.id);
  }
}

export interface OrchestratorHandle {
  stop: () => void;
}

export function startOrchestrator(db: Database.Database, opts: TickOpts & { tickMs?: number } = {}): OrchestratorHandle {
  resetStaleRunning(db, new Date());
  const tickMs = opts.tickMs ?? (Number(process.env.SWRM_TICK_MS) || 30_000);
  const handle = setInterval(() => {
    tickOnce(db, opts).catch(() => { /* errors are recorded per-skill; never crash the loop */ });
  }, tickMs);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
}
