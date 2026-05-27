// scripts/pm/sync_md.ts — bridge tasks/todo.md + tasks/backlog.md into
// the SQLite tasks table so rep sees a single canonical list at /tasks.
//
// Phase 1 (US-VK-R-005):
//   - INSERT tasks for markdown checkbox rows ('- [ ] ...') not yet
//     tracked (matched by external_md_ref = "<basename>:<line_no>").
//   - When an existing SQLite task with external_md_ref no longer
//     appears in markdown, ARCHIVE it (set archived_at). Don't delete
//     — rep may want to recover.
//   - Closed rows ('- [x] ~~...~~ — shipped …') get status='done'
//     unless they're already in a non-done state in SQLite (we don't
//     overwrite manual rep updates).
//
// Future phases (out of scope here):
//   - SQLite-only tasks written back into a managed section of
//     backlog.md
//   - Section-aware classification (BLOCKING YOU vs READY vs WATCH
//     → priority bands)

import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { getDb } from './db';

export interface ParsedMdRow {
  title: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
  line_ref: string; // "<basename>:<line_no>"
  priority?: 'high' | 'medium' | 'low';
}

const CHECKBOX_RE = /^- \[([ x])\] (.*)$/;

/**
 * Extract the visible task title from a markdown checkbox body, stripping
 * **bold** markers, ~~strikethrough~~, trailing fragments after `—`, and
 * inline backtick code refs.
 */
function extractTitle(body: string): string {
  let s = body.trim();
  // Drop ~~ wrappers entirely (we already know strike means done)
  s = s.replace(/~~/g, '');
  // Strip **bold** markers but keep the inner text
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  // Strip any stray ** markers left over (unbalanced)
  s = s.replace(/\*\*/g, '');
  // Truncate at first ' — ' or ' - ' (separators before commentary)
  const dashIdx = s.search(/\s—\s|\s-\s/);
  if (dashIdx > 0) s = s.slice(0, dashIdx);
  // Trim trailing (Pn) / (~Nd) / (autonomous, …) parentheticals which
  // are metadata not part of the title.
  s = s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  return s.slice(0, 200);
}

function inferPriority(body: string): 'high' | 'medium' | 'low' | undefined {
  const m = body.match(/\bP([0-4])\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 1) return 'high';
  if (n === 2) return 'medium';
  return 'low';
}

export function parseBacklogMd(text: string, basename: string): ParsedMdRow[] {
  const lines = text.split('\n');
  const rows: ParsedMdRow[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(CHECKBOX_RE);
    if (!m) continue;
    const checked = m[1] === 'x';
    const body = m[2];
    const title = extractTitle(body);
    if (title.length === 0) continue;
    rows.push({
      title,
      status: checked ? 'done' : 'backlog',
      line_ref: `${basename}:${i + 1}`,
      priority: inferPriority(body),
    });
  }
  return rows;
}

export interface SyncResult {
  parsed: number;
  inserted: number;
  archived: number;
  unchanged: number;
}

export function syncMarkdownToSqlite(
  db: Database.Database,
  mdFiles: string[],
  opts: { boardSlug?: string } = {},
): SyncResult {
  const boardSlug = opts.boardSlug ?? 'personal';
  const board = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get(boardSlug) as
    | { id: number }
    | undefined;
  if (!board) throw new Error(`board '${boardSlug}' not found — run pm:seed first`);

  const allParsed: ParsedMdRow[] = [];
  for (const file of mdFiles) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    allParsed.push(...parseBacklogMd(text, path.basename(file)));
  }

  const result: SyncResult = { parsed: allParsed.length, inserted: 0, archived: 0, unchanged: 0 };

  const seenRefs = new Set(allParsed.map((r) => r.line_ref));
  const findExisting = db.prepare(
    `SELECT id, archived_at FROM tasks WHERE external_md_ref = ?`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (board_id, title, status, priority, external_md_ref)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const archiveStmt = db.prepare(
    `UPDATE tasks SET archived_at = datetime('now')
     WHERE external_md_ref IS NOT NULL
       AND external_md_ref NOT IN (SELECT value FROM json_each(?))
       AND archived_at IS NULL`,
  );

  for (const row of allParsed) {
    const existing = findExisting.get(row.line_ref) as { id: number; archived_at: string | null } | undefined;
    if (existing) {
      result.unchanged += 1;
      continue;
    }
    insertTask.run(board.id, row.title, row.status, row.priority ?? null, row.line_ref);
    result.inserted += 1;
  }

  // Archive SQLite rows whose md line vanished
  const archResult = archiveStmt.run(JSON.stringify(Array.from(seenRefs)));
  result.archived = archResult.changes;

  return result;
}

const DEFAULT_FILES = ['tasks/todo.md', 'tasks/backlog.md'];

if (require.main === module) {
  const ROOT = path.resolve(__dirname, '..', '..');
  const files = DEFAULT_FILES.map((f) => path.join(ROOT, f));
  const db = getDb();
  const r = syncMarkdownToSqlite(db, files);
  // eslint-disable-next-line no-console
  console.log(`[pm:sync-md] parsed ${r.parsed} · inserted ${r.inserted} · archived ${r.archived} · unchanged ${r.unchanged}`);
}
