// scripts/pm/api/agents/bug_fix.ts — US-025 bug-fix agent (detect + ticket).
//
// Pipeline:
//   1. Caller hands us a batch of ErrorSample rows (the adapter to Firestore
//      `error_events` + local `tasks/pm.log` lives outside this module — we
//      take the abstract sample shape so tests stay deterministic and the
//      Firestore wiring can swap freely).
//   2. Group samples by signature: top-level stack frame + first 8 words of
//      message stem. Whitespace + ids/uuids/numbers normalized so the same
//      bug at different timestamps collapses.
//   3. For each signature group:
//      - If a task w/ matching `description` marker exists (sig:<hash>)
//        → bump samples_count + updated_at; never dupe.
//      - Else → create a task on the 'AI Agent Tasks' board w/ label 'bug',
//        inferred priority, trimmed stack + sample count in description.
//   4. Write ONE agent_runs row per poll (NOT per sample) — `notes` captures
//      total samples + created/updated counts so the Daily Log can trend.
//
// Priority inference (PRD US-025 spec):
//   - P0 (high) if the message indicates crash / auth / data-loss
//   - P1 (medium) if user-visible (UI, render, fetch error in client)
//   - P2 (low)   otherwise (log noise, infra warnings)

import * as crypto from 'node:crypto';
import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../../db';

export interface ErrorSample {
  message: string;
  stack?: string | null;
  source?: string | null;       // 'firestore' | 'pm.log' | 'manual' …
  occurred_at?: string | null;  // ISO; defaults to "now" at ingest
}

export interface BugFixResult {
  agent_run_id: number;
  signatures_seen: number;
  tickets_created: number;
  tickets_updated: number;
  details: Array<{
    signature: string;
    task_id: number;
    samples_count: number;
    was_created: boolean;
  }>;
}

const SIG_MARKER_RE = /\bsig:([a-f0-9]{12})\b/;
const TASKS_BOARD_SLUG = 'ai-agent-tasks';
const BUG_LABEL = 'bug';

// ── signature derivation ─────────────────────────────────────────────

// Strip session/request ids, numbers, uuids, hex chunks so two firings of
// the same bug at different timestamps collapse to one signature.
function normalizeMessage(raw: string): string {
  return raw
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Top-level stack frame heuristic: first line of stack that contains a file
// reference. Falls back to first non-empty line.
function topFrame(stack: string | null | undefined): string {
  if (!stack) return '';
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/\bat\s+/.test(l) || /\.(ts|tsx|js|jsx|py):\d+/.test(l)) return l;
  }
  return lines[0] ?? '';
}

export function signatureFor(s: ErrorSample): string {
  const stem = normalizeMessage(s.message).split(' ').slice(0, 8).join(' ');
  const frame = normalizeMessage(topFrame(s.stack));
  // 12 hex chars = 48 bits; collision-unrealistic at any realistic bug count.
  return crypto.createHash('sha1').update(`${frame}\n${stem}`).digest('hex').slice(0, 12);
}

// Pull `sig:<hash>` out of a description blob so we can match without an
// extra column. Returns null if not present.
function extractSigFromDescription(desc: string | null): string | null {
  if (!desc) return null;
  const m = desc.match(SIG_MARKER_RE);
  return m ? m[1] : null;
}

// ── priority inference ───────────────────────────────────────────────

const P0_PATTERNS = [
  /\bsegfault\b/i,
  /\bunhandled\b.*\bexception\b/i,
  /\bauth(?:n|z)?\b.*\bfail/i,
  /\bunauthori[sz]ed\b/i,
  /\bdata[ -]?loss\b/i,
  /\bcorrupt(?:ed|ion)\b/i,
  /\bcrash(?:ed)?\b/i,
  /\bENOSPC\b/,
  /\bOOM\b|\bout of memory\b/i,
];

const P1_PATTERNS = [
  /\brender(?:ing)?\b.*\bfail/i,
  /\bUI\b.*\berror\b/i,
  /\bfetch\b.*\bfail/i,
  /\bnetwork\b.*\berror\b/i,
  /\b4\d\d\b/,                 // client-facing 4xx
  /\bvisible\b/i,
  /\bblank\b.*\bscreen\b/i,
];

export function inferPriority(s: ErrorSample): 'high' | 'medium' | 'low' {
  const text = `${s.message ?? ''}\n${s.stack ?? ''}`;
  if (P0_PATTERNS.some((re) => re.test(text))) return 'high';
  if (P1_PATTERNS.some((re) => re.test(text))) return 'medium';
  return 'low';
}

// ── DB helpers ───────────────────────────────────────────────────────

function getAgentBoardId(db: Database.Database): number {
  const row = db.prepare(`SELECT id FROM boards WHERE slug = ?`).get(TASKS_BOARD_SLUG) as { id: number } | undefined;
  if (!row) throw new Error(`bug-fix agent: '${TASKS_BOARD_SLUG}' board missing — run npm run pm:seed`);
  return row.id;
}

function getOrCreateBugLabelId(db: Database.Database): number {
  const row = db.prepare(`SELECT id FROM labels WHERE name = ? AND board_id IS NULL LIMIT 1`).get(BUG_LABEL) as { id: number } | undefined;
  if (row) return row.id;
  // labels table is seeded in US-002 so this is only a defensive path.
  const r = db.prepare(`INSERT INTO labels (name, color, board_id) VALUES (?, '#ef5350', NULL)`).run(BUG_LABEL);
  return r.lastInsertRowid as number;
}

function findTaskBySig(db: Database.Database, sig: string): { id: number; samples_count: number; description: string | null } | null {
  const rows = db
    .prepare(`SELECT id, samples_count, description FROM tasks WHERE archived_at IS NULL`)
    .all() as Array<{ id: number; samples_count: number; description: string | null }>;
  for (const r of rows) {
    if (extractSigFromDescription(r.description) === sig) return r;
  }
  return null;
}

// ── core ─────────────────────────────────────────────────────────────

interface SigGroup {
  signature: string;
  samples: ErrorSample[];
}

function groupBySignature(samples: ErrorSample[]): SigGroup[] {
  const map = new Map<string, SigGroup>();
  for (const s of samples) {
    const sig = signatureFor(s);
    const existing = map.get(sig);
    if (existing) existing.samples.push(s);
    else map.set(sig, { signature: sig, samples: [s] });
  }
  return Array.from(map.values());
}

function buildTitle(sample: ErrorSample): string {
  const msg = normalizeMessage(sample.message).slice(0, 140);
  return `[bug] ${msg}`;
}

function buildDescription(sample: ErrorSample, sig: string, samplesCount: number): string {
  const trimmedStack = (sample.stack ?? '').split('\n').slice(0, 8).join('\n');
  const src = sample.source ? `\nSource: ${sample.source}` : '';
  return [
    `Auto-filed by bug-fix agent (US-025).`,
    `sig:${sig}`,
    `Samples seen: ${samplesCount}`,
    src.trim(),
    '',
    'First message:',
    sample.message,
    '',
    'Stack (top 8):',
    '```',
    trimmedStack || '(no stack provided)',
    '```',
  ].filter(Boolean).join('\n');
}

function attachBugLabel(db: Database.Database, taskId: number, bugLabelId: number): void {
  db.prepare(`INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)`).run(taskId, bugLabelId);
}

export function ingestErrorSamples(
  db: Database.Database,
  samples: ErrorSample[],
): BugFixResult {
  const boardId = getAgentBoardId(db);
  const bugLabelId = getOrCreateBugLabelId(db);

  const groups = groupBySignature(samples);
  const details: BugFixResult['details'] = [];
  let created = 0;
  let updated = 0;

  const insertTask = db.prepare(
    `INSERT INTO tasks (board_id, title, status, priority, description, samples_count)
     VALUES (?, ?, 'backlog', ?, ?, ?)`,
  );
  const bumpSamples = db.prepare(
    `UPDATE tasks SET samples_count = samples_count + ?, updated_at = datetime('now') WHERE id = ?`,
  );

  for (const g of groups) {
    const first = g.samples[0];
    const priority = inferPriority(first);
    const existing = findTaskBySig(db, g.signature);

    if (existing) {
      bumpSamples.run(g.samples.length, existing.id);
      attachBugLabel(db, existing.id, bugLabelId);
      const newCount = existing.samples_count + g.samples.length;
      details.push({ signature: g.signature, task_id: existing.id, samples_count: newCount, was_created: false });
      updated += 1;
    } else {
      const title = buildTitle(first);
      const desc = buildDescription(first, g.signature, g.samples.length);
      const r = insertTask.run(boardId, title, priority, desc, g.samples.length);
      const taskId = r.lastInsertRowid as number;
      attachBugLabel(db, taskId, bugLabelId);
      details.push({ signature: g.signature, task_id: taskId, samples_count: g.samples.length, was_created: true });
      created += 1;
    }
  }

  const notes = `samples=${samples.length} sigs=${groups.length} created=${created} updated=${updated}`;
  const runRow = db
    .prepare(
      `INSERT INTO agent_runs (agent_name, action, status, notes)
       VALUES ('bug_fix', 'ingest', 'ok', ?)`,
    )
    .run(notes);

  return {
    agent_run_id: runRow.lastInsertRowid as number,
    signatures_seen: groups.length,
    tickets_created: created,
    tickets_updated: updated,
    details,
  };
}

// ── http handler ─────────────────────────────────────────────────────
//
// POST /api/agents/bug-fix/ingest  { samples: ErrorSample[] }
//
// Synchronous (small batches only). The 5-minute Firestore poller lives in
// scripts/pm/agents/bug_fix_poller.ts (CLI; not in this module) and calls
// this same ingestErrorSamples() function directly w/o going through HTTP.

async function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
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

export async function bugFixIngestHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = req.url ?? '/';
  if (req.method !== 'POST' || (url !== '/api/agents/bug-fix/ingest' && url !== '/api/agents/bug-fix/ingest/')) {
    return false;
  }

  let body: { samples?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON body: ${(err as Error)?.message ?? err}` });
    return true;
  }
  if (!Array.isArray(body.samples)) {
    sendJson(res, 400, { error: 'samples[] array required' });
    return true;
  }

  try {
    const result = ingestErrorSamples(db, body.samples as ErrorSample[]);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
  }
  return true;
}
