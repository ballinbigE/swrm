// scripts/pm/api/suggestions.ts — US-022 "what should I do today" surface.
//
//   GET /api/suggestions/today[?board_id=N][&limit=N]
//
// Pipeline:
//   1. Load open tasks across all boards (or one if board_id given).
//   2. Re-use the deterministic heuristicScore from US-024 — single source
//      of truth for "what's urgent now".
//   3. Take top N (default 5, clamped 3..10 per PRD).
//   4. Tag each w/ a one-sentence rationale derived from WHY it scored —
//      no LLM call by default (US-022 spec doesn't require it; keeps the
//      "Refresh" button cheap + offline). Optional opts.useLlm path is
//      available for the chat-command (US-021) entrypoint that wants
//      prose-y phrasing.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { heuristicScore } from './agents/prioritize_backlog';

interface TaskRow {
  id: number;
  board_id: number;
  title: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  effort_hours: number | null;
  position: number;
  blockers: string | null;
  created_at: string;
  epic_id: number | null;
}

export interface Suggestion {
  task_id: number;
  board_id: number;
  title: string;
  priority: string | null;
  due_date: string | null;
  effort_hours: number | null;
  score: number;
  rationale: string;
}

export interface SuggestionsResult {
  generated_at: string;
  count: number;
  suggestions: Suggestion[];
}

export interface SuggestionsOpts {
  board_id?: number;
  limit?: number;
  now?: Date;
}

function loadTasks(db: Database.Database, board_id?: number): TaskRow[] {
  const base = `SELECT id, board_id, title, status, priority, due_date, effort_hours,
                       position, blockers, created_at, epic_id
                  FROM tasks
                 WHERE archived_at IS NULL
                   AND status != 'done'`;
  if (board_id !== undefined) {
    return db.prepare(`${base} AND board_id = ?`).all(board_id) as TaskRow[];
  }
  return db.prepare(base).all() as TaskRow[];
}

function collectBlockersOfOthers(tasks: TaskRow[]): Set<number> {
  const out = new Set<number>();
  for (const t of tasks) {
    if (!t.blockers) continue;
    for (const m of t.blockers.matchAll(/\b(\d+)\b/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

function collectRecentErrorTaskIds(db: Database.Database): Set<number> {
  return new Set<number>(
    (
      db
        .prepare(
          `SELECT DISTINCT task_id
             FROM agent_runs
            WHERE status = 'error'
              AND task_id IS NOT NULL
              AND created_at >= datetime('now', '-7 days')`,
        )
        .all() as Array<{ task_id: number | null }>
    )
      .map((r) => r.task_id)
      .filter((x): x is number => x !== null),
  );
}

// Decode the score back into the most-load-bearing reason so the rep can
// trust the rank ("why is THIS one on the list?"). PRD ranking order:
// P0 blockers first → overdue → due-this-week+high-effort → unblock-others
// → quick-wins.
function rationaleFor(t: TaskRow, ctx: {
  now: Date;
  blockersOfOthers: Set<number>;
  recentErrorTaskIds: Set<number>;
}): string {
  const now = ctx.now;
  const dueDays = (() => {
    if (!t.due_date) return null;
    const ms = Date.parse(t.due_date);
    if (!Number.isFinite(ms)) return null;
    return Math.round((ms - now.getTime()) / 86_400_000);
  })();

  // PRD-ordered: blocker-priority + overdue beats everything else.
  if (t.priority === 'high' && dueDays !== null && dueDays < 0) {
    return `Overdue ${-dueDays}d at ${t.priority} priority — clear blocker first.`;
  }
  if (dueDays !== null && dueDays < 0) {
    return `Overdue ${-dueDays}d — likely missed commitment.`;
  }
  if (ctx.blockersOfOthers.has(t.id)) {
    return `Other tasks reference this in their blockers — unblock the chain.`;
  }
  if (dueDays !== null && dueDays === 0) {
    return `Due today — finish or push the date.`;
  }
  if (dueDays !== null && dueDays > 0 && dueDays <= 7 && t.priority === 'high') {
    return `Due in ${dueDays}d at high priority — start while runway exists.`;
  }
  if (ctx.recentErrorTaskIds.has(t.id)) {
    return `Bug-fix agent saw this signature in the last 7d — likely still firing.`;
  }
  if ((t.effort_hours ?? 99) <= 1 && t.priority !== 'low') {
    return `Quick win (~${t.effort_hours ?? '?'}h) at ${t.priority ?? 'unset'} priority — close the loop.`;
  }
  if (t.priority === 'high') {
    return `High priority + nothing else more urgent today.`;
  }
  return `Top of the heuristic-ranked open work.`;
}

export function getTodaysSuggestions(
  db: Database.Database,
  opts: SuggestionsOpts = {},
): SuggestionsResult {
  const now = opts.now ?? new Date();
  const limit = Math.max(3, Math.min(10, opts.limit ?? 5));
  const tasks = loadTasks(db, opts.board_id);
  if (tasks.length === 0) {
    return { generated_at: now.toISOString(), count: 0, suggestions: [] };
  }

  const ctx = {
    now,
    blockersOfOthers: collectBlockersOfOthers(tasks),
    recentErrorTaskIds: collectRecentErrorTaskIds(db),
  };

  const scored = tasks
    .map((t) => ({ t, score: heuristicScore(t, ctx) }))
    .sort((a, b) => b.score - a.score || a.t.position - b.t.position);

  const suggestions: Suggestion[] = scored.slice(0, limit).map(({ t, score }) => ({
    task_id: t.id,
    board_id: t.board_id,
    title: t.title,
    priority: t.priority,
    due_date: t.due_date,
    effort_hours: t.effort_hours,
    score,
    rationale: rationaleFor(t, ctx),
  }));

  return { generated_at: now.toISOString(), count: suggestions.length, suggestions };
}

// ── http handler ─────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const ROUTE_RE = /^\/api\/suggestions\/today\/?(?:\?.*)?$/;

export function suggestionsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): boolean {
  const url = req.url ?? '/';
  if (req.method !== 'GET' || !ROUTE_RE.test(url)) return false;

  let board_id: number | undefined;
  let limit: number | undefined;
  const qStart = url.indexOf('?');
  if (qStart >= 0) {
    const params = new URLSearchParams(url.slice(qStart + 1));
    const bid = params.get('board_id');
    const lim = params.get('limit');
    if (bid && Number.isFinite(Number(bid))) board_id = Number(bid);
    if (lim && Number.isFinite(Number(lim))) limit = Number(lim);
  }

  try {
    const result = getTodaysSuggestions(db, { board_id, limit });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
  }
  return true;
}
