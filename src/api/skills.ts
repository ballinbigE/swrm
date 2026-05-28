// swrm/src/api/skills.ts — query + mutation layer for Skill Cards.
//   GET  (via listSkills)         -> /skills view
//   POST /api/skills/:id/run      -> run now (bypasses schedule)
//   PATCH /api/skills/:id {enabled} -> pause/resume + rewrite the card line

import * as fs from 'node:fs';
import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { runSkillRow, type SkillRow, type TickOpts } from '../skills/orchestrator';
import type { Skill } from '../skills/types';

interface RawSkill {
  id: number;
  name: string;
  project: string;
  type: string;
  enabled: number;
  frequency: string;
  side_effects: string;
  timeout: number;
  agent: string | null;
  needs_worktree: number;
  mcp: string;
  command: string | null;
  prompt_ref: string | null;
  on_findings: string;
  last_run: string | null;
  next_due: string | null;
  last_status: string;
  file_path: string | null;
  body_hash: string | null;
  updated_at: string;
}

function hydrate(r: RawSkill): Skill {
  return {
    ...r,
    enabled: r.enabled === 1,
    needs_worktree: r.needs_worktree === 1,
    mcp: JSON.parse(r.mcp || '[]') as string[],
  } as Skill;
}

export function listSkills(db: Database.Database): Skill[] {
  const rows = db.prepare(`SELECT * FROM skills ORDER BY project, name`).all() as RawSkill[];
  return rows.map(hydrate);
}

export function getSkillRowById(db: Database.Database, id: number): SkillRow | undefined {
  return db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as SkillRow | undefined;
}

export interface SkillRunRow {
  id: number;
  status: string;
  notes: string | null;
  findings_count: number | null;
  created_at: string;
  finished_at: string | null;
}

export function getSkillRuns(db: Database.Database, id: number, limit = 20): SkillRunRow[] {
  return db
    .prepare(
      `SELECT id, status, notes, findings_count, created_at, finished_at
       FROM agent_runs WHERE skill_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(id, limit) as SkillRunRow[];
}

export class SkillError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function setSkillEnabled(db: Database.Database, id: number, enabled: boolean): Skill {
  const row = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as RawSkill | undefined;
  if (!row) throw new SkillError(404, `skill ${id} not found`);

  db.prepare(`UPDATE skills SET enabled = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, id);

  // Keep the source card in sync (file is the source of truth).
  if (row.file_path && fs.existsSync(row.file_path)) {
    const text = fs.readFileSync(row.file_path, 'utf8');
    const rewritten = text.replace(/^(enabled:\s*)(true|false)\s*$/m, `$1${enabled}`);
    if (rewritten !== text) fs.writeFileSync(row.file_path, rewritten);
  }

  return hydrate(db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as RawSkill);
}

export async function runSkillNow(
  db: Database.Database,
  id: number,
  opts: TickOpts = {},
): Promise<{ status: 'ok' | 'error' } | { skipped: true }> {
  const row = getSkillRowById(db, id);
  if (!row) throw new SkillError(404, `skill ${id} not found`);
  return runSkillRow(db, row, opts);
}

// ── http ────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, maxBytes = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const RUN_RE = /^\/api\/skills\/(\d+)\/run\/?$/;
const SKILL_RE = /^\/api\/skills\/(\d+)\/?$/;

export async function skillsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';

  const runMatch = url.match(RUN_RE);
  if (runMatch) {
    if (method !== 'POST') { sendJson(res, 405, { error: `method ${method} not allowed` }); return true; }
    try {
      const result = await runSkillNow(db, Number(runMatch[1]));
      sendJson(res, 200, { result });
    } catch (err) {
      const e = err as SkillError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  const skillMatch = url.match(SKILL_RE);
  if (skillMatch) {
    if (method !== 'PATCH') { sendJson(res, 405, { error: `method ${method} not allowed` }); return true; }
    let body: { enabled?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      return true;
    }
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'body must include boolean "enabled"' });
      return true;
    }
    try {
      const skill = setSkillEnabled(db, Number(skillMatch[1]), body.enabled);
      sendJson(res, 200, { skill });
    } catch (err) {
      const e = err as SkillError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  return false;
}
