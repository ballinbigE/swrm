// scripts/pm/import_markdown.ts — US-038 / US-031 one-shot markdown → SQLite.
// Reads tasks/{todo,backlog,shipped}.md + tasks/epics/README.md, reuses the
// SAME parseAll the dailyTasksDigest email + scripts/pm_dashboard.ts use
// (single parser, no drift), then upserts Epic + Task rows into the PM DB.
//
//   npm run pm:import           — DRY-RUN; prints created/updated/skipped
//   npm run pm:import -- --apply — performs writes
//
// Match keys (per US-038 spec):
//   - Epic-shaped id  = /^L\d+$/  (no -US- suffix, no -<letter> suffix)
//   - Task-shaped id  = anything else parsed off ## / ### headers
//   - Upsert on TITLE (epics: epics.title; tasks: tasks.title). We do NOT add
//     an import_id column in this pass — keep schema-untouched so the sibling
//     migrations track (US-001 / 002_*) owns the canonical schema.
//
// Source markdown is read-only. Default board for imported tasks = the
// `Work` board (seeded by US-002). If absent, falls back to first board.
//
// Decoupled from the http server: importable as `runImport(db, opts)` so the
// jest test (`__tests__/import_markdown.test.ts`) can drive it against a fresh
// in-memory DB without booting anything.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import {
  parseAll,
  type EpicEntry,
  type ParsedSources,
  type RowFromBacklog,
  type TodoBox,
} from '../../firebase/functions/src/lib/tasks_digest_render';

// ── types ────────────────────────────────────────────────────────────

export interface ImportSources {
  todo: string;
  backlog: string;
  shipped: string;
  epicsReadme: string;
}

export interface ImportCounts {
  created: number;
  updated: number;
  skipped: number;
}

export interface ImportResult {
  epics: ImportCounts;
  tasks: ImportCounts;
  dry_run: boolean;
}

export interface ImportOpts {
  apply?: boolean;
  defaultBoardName?: string;
}

// ── id classification ────────────────────────────────────────────────

// Epic-shaped: bare `L<N>` (no -US-, no -<letter>).
// Per parser regex in tasks_digest_render.ts, ids look like:
//   L741                 → epic
//   L741-US-011          → task (story under epic L741)
//   L394-b               → task (sub-letter under epic L394)
function isEpicId(id: string): boolean {
  return /^L\d+$/.test(id);
}

// Strip trailing `~~` and the leading `L###-... — ` prefix to get the human title.
function humanTitle(raw: string): string {
  return raw
    .replace(/^L\d+(?:-US-?\d+|-[a-z])?\s*[—–-]\s*/, '')
    .replace(/~~/g, '')
    .trim();
}

// Map a parsed row.status (free-form prose) to the canonical 5-status enum
// from FR-3: backlog → todo → in_progress → review → done.
function statusToCanonical(raw: string | undefined, lane: 'backlog' | 'shipped' | 'todo'): string {
  if (lane === 'shipped') return 'done';
  if (lane === 'todo') return 'todo';
  const s = (raw ?? '').toLowerCase().trim();
  if (!s) return 'backlog';
  if (/^(shipped|closed|done|resolved|verified|landed|complete)/.test(s)) return 'done';
  if (/^(in[- ]progress|in flight|in-flight|working|wip)/.test(s)) return 'in_progress';
  if (/^(review|in review|awaiting review)/.test(s)) return 'review';
  if (/^(ready|todo|to[- ]do|next)/.test(s)) return 'todo';
  return 'backlog';
}

function priorityToCanonical(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(P[0-3])/.exec(raw.trim());
  if (!m) return null;
  // PM schema (per PRD FR-4) uses high/med/low; map P0/P1 → high, P2 → med, P3 → low.
  const lvl = m[1];
  if (lvl === 'P0' || lvl === 'P1') return 'high';
  if (lvl === 'P2') return 'med';
  return 'low';
}

function effortToHours(raw: string | undefined): number | null {
  if (!raw || raw === '?') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // backlog `Effort:` is in days; 1d ≈ 6 working hours for solo-IC accounting.
  return n * 6;
}

// ── DB helpers — guarded so a partial schema (missing tables/cols) bails
//    with a readable error instead of an opaque sqlite stack.
// ─────────────────────────────────────────────────────────────────────

interface BoardRow { id: number; name: string }
interface EpicRow { id: number; title: string }
interface TaskRow { id: number; title: string; status: string; epic_id: number | null }

function ensureSchema(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as Array<{ name: string }>;
  const names = new Set(tables.map((t) => t.name));
  for (const need of ['boards', 'epics', 'tasks']) {
    if (!names.has(need)) {
      throw new Error(
        `pm:import — required table "${need}" missing. Run \`npm run pm:migrate\` (US-001) before importing.`,
      );
    }
  }
}

function getDefaultBoardId(db: Database.Database, preferredName: string): number {
  const byName = db.prepare(`SELECT id, name FROM boards WHERE LOWER(name) = LOWER(?) LIMIT 1`).get(preferredName) as BoardRow | undefined;
  if (byName) return byName.id;
  const first = db.prepare(`SELECT id, name FROM boards ORDER BY id ASC LIMIT 1`).get() as BoardRow | undefined;
  if (first) return first.id;
  throw new Error('pm:import — no boards seeded; run `npm run pm:seed` first.');
}

function findEpicByTitle(db: Database.Database, title: string): EpicRow | null {
  const row = db.prepare(`SELECT id, title FROM epics WHERE title = ? LIMIT 1`).get(title) as EpicRow | undefined;
  return row ?? null;
}

function findTaskByTitle(db: Database.Database, title: string): TaskRow | null {
  const row = db
    .prepare(`SELECT id, title, status, epic_id FROM tasks WHERE title = ? LIMIT 1`)
    .get(title) as TaskRow | undefined;
  return row ?? null;
}

// ── core import ──────────────────────────────────────────────────────

export function runImport(
  db: Database.Database,
  sources: ImportSources,
  opts: ImportOpts = {},
): ImportResult {
  ensureSchema(db);
  const apply = !!opts.apply;
  const boardName = opts.defaultBoardName ?? 'Work';
  const boardId = getDefaultBoardId(db, boardName);

  const parsed: ParsedSources = parseAll({
    todo: sources.todo,
    backlog: sources.backlog,
    shipped: sources.shipped,
    epicsReadme: sources.epicsReadme,
  });

  // Collect epic candidates from THREE places:
  //   1. parseEpicsIndex (tasks/epics/README.md table)
  //   2. backlog rows w/ epic-shaped ids
  //   3. shipped rows w/ epic-shaped ids
  // Title = the human form. Dedupe by title.
  const epicTitleSet = new Map<string, { title: string; status: string }>();

  for (const e of parsed.epics) {
    if (!epicTitleSet.has(e.title)) epicTitleSet.set(e.title, { title: e.title, status: e.status || 'unknown' });
  }
  const backlogEpicLike = parsed.backlog.rows.filter((r) => isEpicId(r.id));
  const shippedEpicLike = parsed.shipped.rows.filter((r) => isEpicId(r.id));
  for (const r of backlogEpicLike) {
    const t = humanTitle(r.title) || r.id;
    const labelled = `${r.id} — ${t}`;
    if (!epicTitleSet.has(labelled)) epicTitleSet.set(labelled, { title: labelled, status: r.status ?? 'open' });
  }
  for (const r of shippedEpicLike) {
    const t = humanTitle(r.title) || r.id;
    const labelled = `${r.id} — ${t}`;
    if (!epicTitleSet.has(labelled)) epicTitleSet.set(labelled, { title: labelled, status: 'closed' });
  }

  // ── upsert epics ─────────────────────────────────────────────────
  const epicCounts: ImportCounts = { created: 0, updated: 0, skipped: 0 };
  const insertEpic = db.prepare(
    `INSERT INTO epics (board_id, title, status) VALUES (?, ?, ?)`,
  );
  const updateEpicStatus = db.prepare(`UPDATE epics SET status = ? WHERE id = ?`);

  for (const { title, status } of epicTitleSet.values()) {
    const existing = findEpicByTitle(db, title);
    if (existing) {
      if (status && status.toLowerCase() !== '') {
        if (apply) updateEpicStatus.run(status, existing.id);
        epicCounts.updated += 1;
      } else {
        epicCounts.skipped += 1;
      }
    } else {
      if (apply) insertEpic.run(boardId, title, status || 'open');
      epicCounts.created += 1;
    }
  }

  // ── upsert tasks ─────────────────────────────────────────────────
  // Build canonical (title, status) pairs from backlog (non-epic rows) +
  // shipped (non-epic rows) + todo open boxes. Match on title.
  type TaskCandidate = {
    title: string;
    status: string;
    priority: string | null;
    effort_hours: number | null;
    description: string | null;
    epic_title: string | null;
  };

  const candidates: TaskCandidate[] = [];

  const backlogTaskRows = parsed.backlog.rows.filter((r) => !isEpicId(r.id));
  for (const r of backlogTaskRows) {
    candidates.push(rowToCandidate(r, 'backlog'));
  }
  const shippedTaskRows = parsed.shipped.rows.filter((r) => !isEpicId(r.id));
  for (const r of shippedTaskRows) {
    candidates.push(rowToCandidate(r, 'shipped'));
  }
  for (const box of parsed.todo.boxes) {
    if (box.done) continue;
    candidates.push({
      title: box.text.trim(),
      status: 'todo',
      priority: null,
      effort_hours: null,
      description: null,
      epic_title: null,
    });
  }

  const taskCounts: ImportCounts = { created: 0, updated: 0, skipped: 0 };
  const insertTask = db.prepare(
    `INSERT INTO tasks (board_id, title, status, position, priority, effort_hours, description, epic_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateTask = db.prepare(
    `UPDATE tasks SET status = ?, priority = COALESCE(?, priority), effort_hours = COALESCE(?, effort_hours), description = COALESCE(?, description) WHERE id = ?`,
  );

  // Per-status position counter so newly-created rows land at the end of
  // their column. Existing positions left alone on update.
  const positionByStatus = new Map<string, number>();
  function nextPosition(status: string): number {
    let cur = positionByStatus.get(status);
    if (cur === undefined) {
      const max = db
        .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE status = ?`)
        .get(status) as { m: number } | undefined;
      cur = (max?.m ?? 0);
    }
    cur += 1;
    positionByStatus.set(status, cur);
    return cur;
  }

  for (const c of candidates) {
    if (!c.title) {
      taskCounts.skipped += 1;
      continue;
    }
    const existing = findTaskByTitle(db, c.title);
    const epicId = c.epic_title ? findEpicByTitle(db, c.epic_title)?.id ?? null : null;
    if (existing) {
      if (apply) updateTask.run(c.status, c.priority, c.effort_hours, c.description, existing.id);
      taskCounts.updated += 1;
    } else {
      const pos = apply ? nextPosition(c.status) : 0;
      if (apply) insertTask.run(boardId, c.title, c.status, pos, c.priority, c.effort_hours, c.description, epicId);
      taskCounts.created += 1;
    }
  }

  return {
    epics: epicCounts,
    tasks: taskCounts,
    dry_run: !apply,
  };

  // ── inline helpers ───────────────────────────────────────────────
  function rowToCandidate(r: RowFromBacklog, lane: 'backlog' | 'shipped'): TaskCandidate {
    const title = humanTitle(r.title) || r.id;
    const desc =
      [r.surface, r.action ? `Action: ${r.action}` : null, r.how ? `How: ${r.how}` : null, r.reason ? `Why open: ${r.reason}` : null]
        .filter(Boolean)
        .join('\n\n') || null;
    // Parent epic = strip the -US-NN / -letter suffix; match label "L### — ...".
    let epicTitle: string | null = null;
    const parentMatch = r.id.match(/^(L\d+)(?:-US-?\d+|-[a-z])$/);
    if (parentMatch) {
      // Best-effort: look up an epic row whose title starts with `L### — `.
      const prefix = `${parentMatch[1]} —`;
      const found = db
        .prepare(`SELECT title FROM epics WHERE title LIKE ? LIMIT 1`)
        .get(`${prefix}%`) as { title: string } | undefined;
      if (found) epicTitle = found.title;
    }
    return {
      title,
      status: statusToCanonical(r.status, lane),
      priority: priorityToCanonical(r.priority),
      effort_hours: effortToHours(r.effort),
      description: desc,
      epic_title: epicTitle,
    };
  }
}

// ── source loader (cli convenience) ──────────────────────────────────

export function loadSourcesFromDisk(repoRoot: string): ImportSources {
  const tasksDir = path.join(repoRoot, 'tasks');
  const read = (p: string): string => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    todo: read(path.join(tasksDir, 'todo.md')),
    backlog: read(path.join(tasksDir, 'backlog.md')),
    shipped: read(path.join(tasksDir, 'shipped.md')),
    epicsReadme: read(path.join(tasksDir, 'epics', 'README.md')),
  };
}

// ── cli entrypoint ───────────────────────────────────────────────────

function formatCounts(label: string, c: ImportCounts): string {
  return `  ${label.padEnd(7)} created ${c.created}  updated ${c.updated}  skipped ${c.skipped}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const repoRoot = path.resolve(__dirname, '..', '..');
  const sources = loadSourcesFromDisk(repoRoot);

  // Dynamic require of `./db` keeps this module testable without the
  // sibling-track scaffolding present at type-check time. The CLI is the
  // only consumer that needs a real DB handle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require('./db') as { getDb: () => Database.Database };
  const db = getDb();

  const result = runImport(db, sources, { apply });

  // eslint-disable-next-line no-console
  console.log(`[pm:import] ${result.dry_run ? 'DRY-RUN (pass --apply to write)' : 'APPLIED'}`);
  // eslint-disable-next-line no-console
  console.log(formatCounts('epics', result.epics));
  // eslint-disable-next-line no-console
  console.log(formatCounts('tasks', result.tasks));
}

// Sentinel-call so `tsx scripts/pm/import_markdown.ts` runs `main()` but
// `import { runImport }` from the test stays pure.
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[pm:import] failed:', err?.message ?? err);
    process.exit(1);
  });
}

// silence "unused" complaints — these types are re-exported transitively.
export type { EpicEntry, TodoBox };
