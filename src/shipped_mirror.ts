// scripts/pm/shipped_mirror.ts — mirror DB closures to tasks/shipped.md so the
// rep-facing markdown dashboard (parsed by scripts/pm_dashboard.ts +
// firebase/functions dailyTasksDigest) reflects API-driven closures.
//
// Set PM_SHIPPED_MD_PATH (server.ts main() does this) to enable; tests + the
// pm:import CLI default to disabled so they never touch the real markdown.
//
// Idempotency: every appended row carries `pm:T<id>` so the same closure
// firing twice (e.g. PATCH status=done followed by DELETE archive on the
// same id) yields ONE row, not two.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

const TODAY_HEADER = (iso: string) => `## ${iso} — PM Dashboard auto-close`;
const PREAMBLE = '_Rows auto-appended by `scripts/pm/shipped_mirror.ts` when DB tasks transition to done/archived. Manual entries above remain authoritative._';

interface TaskSnapshot {
  id: number;
  title: string;
  priority: string | null;
}

function getMirrorPath(): string | null {
  const p = process.env.PM_SHIPPED_MD_PATH;
  if (!p) return null;
  return path.resolve(p);
}

function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function loadTask(db: Database.Database, id: number): TaskSnapshot | null {
  const row = db
    .prepare(`SELECT id, title, priority FROM tasks WHERE id = ?`)
    .get(id) as TaskSnapshot | undefined;
  return row ?? null;
}

// Insert (or extend) today's "PM Dashboard auto-close" section with one row
// per closure. Caller decides what reason text to log.
export function mirrorClosure(
  db: Database.Database,
  taskId: number,
  reason: 'status_done' | 'archived',
  now: Date = new Date(),
): { mirrored: boolean; reason?: string } {
  const filePath = getMirrorPath();
  if (!filePath) return { mirrored: false, reason: 'PM_SHIPPED_MD_PATH unset' };

  const task = loadTask(db, taskId);
  if (!task) return { mirrored: false, reason: 'task not found' };

  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { mirrored: false, reason: 'shipped.md unreadable' };
  }

  const marker = `pm:T${task.id}`;
  if (body.includes(marker)) {
    return { mirrored: false, reason: 'already mirrored' };
  }

  const iso = todayIso(now);
  const todayHeader = TODAY_HEADER(iso);
  const row = [
    ``,
    `### ${marker} — ${task.title}`,
    ``,
    `- **Status:** done ${iso} (via PM API — ${reason})`,
    `- **Priority:** ${task.priority ?? '—'}`,
    `- **Refs:** \`pm.db\` task id ${task.id}`,
    ``,
  ].join('\n');

  const hasTodaySection = body.includes(todayHeader);
  let nextBody: string;
  if (hasTodaySection) {
    // Append the row under the existing today section. Insert just before the
    // NEXT `## ` header (if any), else at end-of-file.
    const idx = body.indexOf(todayHeader);
    const after = body.indexOf('\n## ', idx + todayHeader.length);
    if (after === -1) {
      nextBody = body.replace(/\s*$/, '') + '\n' + row;
    } else {
      nextBody = body.slice(0, after) + row + body.slice(after);
    }
  } else {
    // New today section — insert right after the file preamble (between the
    // top H1 and the first `## ` header). If neither found, append.
    const firstSection = body.indexOf('\n## ');
    const newSection = `\n${todayHeader}\n\n${PREAMBLE}\n${row}`;
    if (firstSection === -1) {
      nextBody = body.replace(/\s*$/, '') + '\n' + newSection;
    } else {
      nextBody = body.slice(0, firstSection) + newSection + body.slice(firstSection);
    }
  }

  fs.writeFileSync(filePath, nextBody, 'utf8');
  return { mirrored: true };
}
