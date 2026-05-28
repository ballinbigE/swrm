// swrm/src/skills/runlog.ts — shared run-recording helpers for skill executors.
//
//   recordRun       — insert one agent_runs row (the run history / audit trail).
//   appendRunToCard — prepend a dated entry to the card's `## Runs` section,
//                     newest first, capped. The card stays the human-readable,
//                     git-tracked audit log.

import * as fs from 'node:fs';

import type Database from 'better-sqlite3';

export interface RecordRunInput {
  skill_id: number;
  agent_name: string;
  action: string;
  status: 'ok' | 'error' | 'skipped';
  notes?: string | null;
  findings_count?: number | null;
  finished_at?: string | null;
}

export function recordRun(db: Database.Database, r: RecordRunInput): number {
  const row = db
    .prepare(
      `INSERT INTO agent_runs (agent_name, action, status, skill_id, findings_count, notes, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.agent_name, r.action, r.status, r.skill_id, r.findings_count ?? null, r.notes ?? null, r.finished_at ?? null);
  return row.lastInsertRowid as number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time stamp for a card Runs entry (D-2: swrm is a localhost tool). */
export function formatWhen(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface RunEntry {
  when: string;
  status: string;
  durationMs: number;
  summary: string;
}

const RUNS_HEADER = '## Runs';
const DEFAULT_CAP = 20;

export function appendRunToCard(filePath: string, e: RunEntry, cap = DEFAULT_CAP): void {
  const raw = fs.readFileSync(filePath, 'utf8');
  const block = `### ${e.when} — ${e.status} (${(e.durationMs / 1000).toFixed(1)}s)\n- ${e.summary}`;

  const parts = raw.split(/^## Runs\s*$/m);
  const head = parts[0].replace(/\s+$/, '');

  let existing: string[] = [];
  if (parts.length > 1) {
    existing = parts
      .slice(1)
      .join(RUNS_HEADER)
      .split(/\n(?=### )/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const all = [block, ...existing].slice(0, cap);
  fs.writeFileSync(filePath, `${head}\n\n${RUNS_HEADER}\n\n${all.join('\n\n')}\n`);
}
