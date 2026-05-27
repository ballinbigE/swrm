// scripts/pm/api/agents/prioritize_backlog.ts — US-024 of the
// Personal AI PM System PRD.
//
//   POST /api/agents/prioritize-backlog   { board_id, apply?: boolean }
//
// Pipeline:
//   1. load every open task on the board (archived_at IS NULL, status != 'done')
//   2. compute a deterministic heuristic score per task (due-date proximity +
//      dependency unblocking + age-vs-priority + recent error-agent hits)
//   3. ask the US-023 LLM driver to re-rank with a one-sentence rationale per
//      task — if the LLM fails or returns invalid JSON, fall back to the
//      heuristic ordering (proposals still useful; agent_run records the
//      fallback)
//   4. dry-run by default: returns the proposed ordering w/o touching the DB.
//      Caller posts again with { apply: true } to commit (a transaction
//      writes the new `position` per task).
//   5. every call writes one agent_runs row so the Daily Log audits intent
//      vs commit + LLM vs heuristic-fallback.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../../db';
import { chat, type ChatMessage } from '../../llm';

interface TaskRow {
  id: number;
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

export interface PrioritizeProposal {
  task_id: number;
  title: string;
  current_position: number;
  proposed_position: number;
  priority: string | null;
  rationale: string;
}

export interface PrioritizeResult {
  board_id: number;
  proposals: PrioritizeProposal[];
  applied: boolean;
  llm_used: boolean;
  agent_run_id: number;
}

export interface PrioritizeOpts {
  apply?: boolean;
  llm?: typeof chat;
  now?: Date;
}

// ── heuristics ───────────────────────────────────────────────────────

const PRIORITY_WEIGHT: Record<string, number> = { high: 30, medium: 15, low: 5 };

function daysUntil(due: string | null, now: Date): number | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - now.getTime()) / 86_400_000);
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((now.getTime() - t) / 86_400_000));
}

// Higher score = higher urgency = should sit earlier in the backlog.
export function heuristicScore(t: TaskRow, ctx: {
  now: Date;
  blockersOfOthers: Set<number>;
  recentErrorTaskIds: Set<number>;
}): number {
  let score = 0;

  score += PRIORITY_WEIGHT[t.priority ?? ''] ?? 0;

  const days = daysUntil(t.due_date, ctx.now);
  if (days !== null) {
    if (days < 0) score += 50;        // overdue
    else if (days === 0) score += 35; // today
    else if (days <= 3) score += 20;  // this-week
    else if (days <= 7) score += 10;
  }

  // unblock-others: tasks whose IDs appear in another open task's `blockers`
  // string get a strong bump — clearing them frees downstream work.
  if (ctx.blockersOfOthers.has(t.id)) score += 25;

  // age vs priority — old high-pri tasks creep up; old low-pri tasks creep
  // down slightly (avoids backlog rot inversion).
  const age = daysSince(t.created_at, ctx.now);
  if (age >= 14 && t.priority === 'high') score += 8;
  if (age >= 30 && t.priority === 'low') score -= 3;

  // recent error-agent signals — bug tickets the bug-fix agent re-touched
  // recently are hotter than aged ones.
  if (ctx.recentErrorTaskIds.has(t.id)) score += 15;

  return score;
}

// ── core ─────────────────────────────────────────────────────────────

function loadBoardContext(db: Database.Database, board_id: number): {
  tasks: TaskRow[];
  blockersOfOthers: Set<number>;
  recentErrorTaskIds: Set<number>;
} {
  const tasks = db
    .prepare(
      `SELECT id, title, status, priority, due_date, effort_hours,
              position, blockers, created_at, epic_id
         FROM tasks
        WHERE board_id = ?
          AND archived_at IS NULL
          AND status != 'done'
        ORDER BY position ASC, id ASC`,
    )
    .all(board_id) as TaskRow[];

  // Anything mentioned by another open task's `blockers` field as a numeric
  // id → unblock-other candidate. blockers is free-text; we extract bare
  // ints (e.g. "blocked on #42" or "42, 51"). Avoids needing a separate
  // dependency table at this stage.
  const blockersOfOthers = new Set<number>();
  for (const t of tasks) {
    if (!t.blockers) continue;
    for (const m of t.blockers.matchAll(/\b(\d+)\b/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) blockersOfOthers.add(n);
    }
  }

  // Recent error-agent signals: agent_runs in the last 7 days w/ status='error'
  // referencing one of our task ids.
  const recentErrorTaskIds = new Set<number>(
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

  return { tasks, blockersOfOthers, recentErrorTaskIds };
}

function buildLlmPrompt(tasks: TaskRow[], scored: Array<{ id: number; score: number }>): ChatMessage[] {
  const summary = tasks.map((t) => {
    const s = scored.find((x) => x.id === t.id)?.score ?? 0;
    return `#${t.id} [${t.priority ?? '-'}] (due:${t.due_date ?? '-'}, age:${t.created_at.slice(0, 10)}, score:${s}) ${t.title}`;
  }).join('\n');

  const system =
    'You re-rank an engineering backlog. Each task already has a numeric ' +
    'heuristic score (higher = more urgent). Respect that signal but ' +
    'use judgment on tie-breaks. Output STRICT JSON ONLY (no prose, no ' +
    'code fences) in this shape:\n' +
    '{"ranking":[{"task_id":N,"rationale":"<=1 sentence why this position"}]}';

  const user =
    `Re-rank these ${tasks.length} open tasks. Return every task id exactly ` +
    `once in your preferred order (most urgent first).\n\n${summary}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

interface LlmRanking {
  ranking: Array<{ task_id: number; rationale: string }>;
}

function parseLlmReply(reply: string): LlmRanking | null {
  try {
    const trimmed = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const r = (parsed as { ranking?: unknown }).ranking;
    if (!Array.isArray(r)) return null;
    const ranking: LlmRanking['ranking'] = [];
    for (const item of r) {
      if (!item || typeof item !== 'object') return null;
      const o = item as { task_id?: unknown; rationale?: unknown };
      const id = Number(o.task_id);
      const why = String(o.rationale ?? '').trim();
      if (!Number.isFinite(id) || !why) return null;
      ranking.push({ task_id: id, rationale: why });
    }
    return { ranking };
  } catch {
    return null;
  }
}

function writeAgentRun(
  db: Database.Database,
  notes: string,
  status: 'ok' | 'error' | 'skipped',
): number {
  const r = db
    .prepare(
      `INSERT INTO agent_runs (agent_name, action, status, notes)
       VALUES ('prioritize_backlog', 'rerank', ?, ?)`,
    )
    .run(status, notes);
  return r.lastInsertRowid as number;
}

export async function runPrioritize(
  db: Database.Database,
  board_id: number,
  opts: PrioritizeOpts = {},
): Promise<PrioritizeResult> {
  if (!Number.isFinite(board_id) || board_id <= 0) {
    const err = new Error('board_id required');
    (err as Error & { code?: string }).code = 'VALIDATION';
    throw err;
  }
  const boardExists = db.prepare(`SELECT 1 FROM boards WHERE id = ?`).get(board_id);
  if (!boardExists) {
    const err = new Error(`board ${board_id} not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }

  const apply = !!opts.apply;
  const now = opts.now ?? new Date();
  const llmCall = opts.llm ?? chat;

  const { tasks, blockersOfOthers, recentErrorTaskIds } = loadBoardContext(db, board_id);

  if (tasks.length === 0) {
    const runId = writeAgentRun(db, `board=${board_id} no open tasks`, 'skipped');
    return { board_id, proposals: [], applied: false, llm_used: false, agent_run_id: runId };
  }

  const scored = tasks.map((t) => ({
    id: t.id,
    score: heuristicScore(t, { now, blockersOfOthers, recentErrorTaskIds }),
  }));

  // Heuristic ordering: highest score first; tie → preserve current position.
  const heuristicOrder = [...tasks].sort((a, b) => {
    const sa = scored.find((x) => x.id === a.id)?.score ?? 0;
    const sb = scored.find((x) => x.id === b.id)?.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.position - b.position;
  });

  // Try LLM re-rank. Fall through to heuristic on any error / bad parse.
  let llmUsed = false;
  let llmRationales = new Map<number, string>();
  let finalOrder = heuristicOrder;
  let runStatus: 'ok' | 'error' | 'skipped' = 'ok';
  let runNotes = '';

  try {
    const reply = await llmCall({ messages: buildLlmPrompt(tasks, scored) });
    const parsed = parseLlmReply(reply.reply);
    if (!parsed) {
      runNotes = 'LLM returned non-JSON or wrong shape — fell back to heuristic';
    } else {
      const seenIds = new Set(parsed.ranking.map((r) => r.task_id));
      const allIdsMatch = parsed.ranking.length === tasks.length && tasks.every((t) => seenIds.has(t.id));
      if (allIdsMatch) {
        llmUsed = true;
        llmRationales = new Map(parsed.ranking.map((r) => [r.task_id, r.rationale]));
        finalOrder = parsed.ranking
          .map((r) => tasks.find((t) => t.id === r.task_id))
          .filter((t): t is TaskRow => t !== undefined);
      } else {
        runNotes = `LLM ranking covered ${seenIds.size}/${tasks.length} ids — fell back to heuristic`;
      }
    }
  } catch (err) {
    runStatus = 'error';
    runNotes = `LLM call failed: ${(err as Error)?.message ?? String(err)} — used heuristic`;
  }

  if (!llmUsed && !runNotes) runNotes = 'heuristic-only (no LLM error)';

  const proposals: PrioritizeProposal[] = finalOrder.map((t, idx) => ({
    task_id: t.id,
    title: t.title,
    current_position: t.position,
    proposed_position: idx,
    priority: t.priority,
    rationale:
      llmRationales.get(t.id) ??
      `heuristic score ${scored.find((x) => x.id === t.id)?.score ?? 0}`,
  }));

  if (apply) {
    const update = db.prepare(`UPDATE tasks SET position = ?, updated_at = datetime('now') WHERE id = ?`);
    const tx = db.transaction((rows: PrioritizeProposal[]) => {
      for (const p of rows) update.run(p.proposed_position, p.task_id);
    });
    tx(proposals);
  }

  const action = apply ? 'apply' : 'dry_run';
  const finalNote =
    `board=${board_id} tasks=${tasks.length} llm=${llmUsed} action=${action}` +
    (runNotes ? ` — ${runNotes}` : '');
  const runId = writeAgentRun(db, finalNote, runStatus);

  return { board_id, proposals, applied: apply, llm_used: llmUsed, agent_run_id: runId };
}

// ── http handler ─────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage, maxBytes = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function prioritizeBacklogHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = req.url ?? '/';
  if (req.method !== 'POST' || (url !== '/api/agents/prioritize-backlog' && url !== '/api/agents/prioritize-backlog/')) {
    return false;
  }

  let body: { board_id?: unknown; apply?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON body: ${(err as Error)?.message ?? err}` });
    return true;
  }

  try {
    const result = await runPrioritize(db, Number(body.board_id), { apply: !!body.apply });
    sendJson(res, 200, result);
  } catch (err) {
    const e = err as Error & { code?: string };
    const code = e.code === 'VALIDATION' ? 400 : e.code === 'NOT_FOUND' ? 404 : 500;
    sendJson(res, code, { error: e.message ?? String(err) });
  }
  return true;
}
