// swrm/api/plan_execute.ts — POST /api/plan/execute.
//
// One-shot: idea → PRD (Anthropic) → write prd-<slug>.json + prd-<slug>.md
// → INSERT each user story as a `tasks` row → optionally spawn an attempt
// on the first task. Combines what the UI used to do across the /api/plan
// preview step + N task creates + a manual spawn into a single call.
//
// Body: { idea: string, auto_spawn?: boolean }
// 200  { prd, prd_path, md_path, task_ids: number[], attempt_id: number|null }
// 400  empty/invalid idea
// 503  ANTHROPIC_API_KEY not set
// 500  any other failure (plan parse, write, db)
//
// readBody + sendJson are copied from src/api/plan.ts to keep this handler
// self-contained (no shared http-util module exists yet). No new npm deps.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { renderPrdMd } from '../lib/prd_md_render';
import { planFromIdea, MissingApiKeyError } from '../plan';
import type { Prd, PrdStory } from '../plan';
import { createAttempt } from './attempts';

// ── http helpers (copied from api/plan.ts) ──────────────────────────────

async function readBody(req: http.IncomingMessage, maxBytes = 200_000): Promise<string> {
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

// ── pure helpers (exported for unit tests) ───────────────────────────────

/**
 * Slug from arbitrary text: lowercase, non-alphanumeric runs → '-', trimmed
 * of leading/trailing dashes, capped at 40 chars. Falls back to 'plan' when
 * the input collapses to empty.
 */
export function slugify(s: string): string {
  const slug = (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''); // re-trim in case the 40-char cut landed on a dash
  return slug.length > 0 ? slug : 'plan';
}

/** Map a story's 1-based numeric priority to the tasks.priority enum. */
export function priorityForStory(priority: number): 'high' | 'medium' | 'low' {
  if (priority <= 1) return 'high';
  if (priority === 2) return 'medium';
  return 'low';
}

export interface TaskRowInput {
  board_id: number;
  title: string;
  description: string;
  status: 'backlog';
  priority: 'high' | 'medium' | 'low';
  external_md_ref: string;
}

/**
 * Turn the PRD's user stories into the exact row shape we INSERT into
 * `tasks`. Pure — no DB access — so the priority mapping + external_md_ref
 * wiring is unit-testable without an Anthropic call.
 *
 * external_md_ref points each row back at its source story in the written
 * PRD json: `prd-<slug>.json#<story.id>`.
 */
export function prdToTaskRows(prd: Prd, boardId: number, slug: string): TaskRowInput[] {
  const stories: PrdStory[] = Array.isArray(prd.userStories) ? prd.userStories : [];
  return stories.map((story) => ({
    board_id: boardId,
    title: story.title,
    description: story.description ?? '',
    status: 'backlog' as const,
    priority: priorityForStory(story.priority),
    external_md_ref: `prd-${slug}.json#${story.id}`,
  }));
}

/** Resolve the 'personal' board id (seeded in 001), falling back to any board. */
function personalBoardId(db: Database.Database): number {
  const row = db.prepare(`SELECT id FROM boards WHERE slug = 'personal' LIMIT 1`).get() as
    | { id: number }
    | undefined;
  if (row) return row.id;
  const any = db.prepare(`SELECT id FROM boards ORDER BY position, id LIMIT 1`).get() as
    | { id: number }
    | undefined;
  if (!any) throw new Error("no boards exist — run npm run pm:seed");
  return any.id;
}

// ── handler ───────────────────────────────────────────────────────────

const PLAN_EXECUTE_RE = /^\/api\/plan\/execute\/?$/;

/**
 * `_planFn` is an injectable override for `planFromIdea` so the happy-path
 * integration test can stub the Anthropic call. Production callers never
 * pass it; it defaults to the real planner.
 */
export async function planExecuteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
  _planFn: typeof planFromIdea = planFromIdea,
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!PLAN_EXECUTE_RE.test(url.split('?')[0])) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: `method ${req.method} not allowed` });
    return true;
  }

  let body: { idea?: unknown; auto_spawn?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return true;
  }

  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (idea.length === 0) {
    sendJson(res, 400, { error: 'idea (non-empty string) is required' });
    return true;
  }
  const autoSpawn = body.auto_spawn === true;

  try {
    const prd = await _planFn(idea);
    const slug = slugify(prd.userStories[0]?.title ?? prd.project ?? 'plan');

    // Write both artifacts to the working directory so the Ralph loop +
    // any external tooling can pick them up.
    const prdPath = path.resolve(process.cwd(), `prd-${slug}.json`);
    const mdPath = path.resolve(process.cwd(), `prd-${slug}.md`);
    fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2) + '\n');
    fs.writeFileSync(mdPath, renderPrdMd(prd));

    const boardId = personalBoardId(db);
    const rows = prdToTaskRows(prd, boardId, slug);

    const insert = db.prepare(
      `INSERT INTO tasks (board_id, title, description, status, priority, external_md_ref)
       VALUES (@board_id, @title, @description, @status, @priority, @external_md_ref)`,
    );
    const taskIds: number[] = [];
    const insertAll = db.transaction((toInsert: TaskRowInput[]) => {
      for (const r of toInsert) {
        const result = insert.run(r);
        taskIds.push(result.lastInsertRowid as number);
      }
    });
    insertAll(rows);

    let attemptId: number | null = null;
    if (autoSpawn && taskIds.length > 0) {
      const firstStory = prd.userStories[0];
      const attempt = await createAttempt(db, taskIds[0] as number, {
        auto_run: true,
        prompt: `${firstStory?.title ?? ''}\n\n${firstStory?.description ?? ''}`,
      });
      attemptId = attempt.id;
    }

    sendJson(res, 200, {
      prd,
      prd_path: prdPath,
      md_path: mdPath,
      task_ids: taskIds,
      attempt_id: attemptId,
    });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      sendJson(res, 503, {
        error: err.message,
        hint: 'export ANTHROPIC_API_KEY before booting the swrm dashboard',
      });
      return true;
    }
    sendJson(res, 500, { error: (err as Error).message });
  }
  return true;
}
