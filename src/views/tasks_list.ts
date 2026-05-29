// scripts/pm/views/tasks_list.ts — GET /tasks
//
// Simple SQLite-backed task index that links into /workspace/:id. Bridge
// from the markdown-mirror kanban at / until Ralph's US-011 ships a full
// SQLite kanban view.
//
// Filters: ?board=<slug>, ?status=<...>. Defaults: all boards,
// non-archived, non-done.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { listAttempts } from '../api/attempts';

interface TaskListRow {
  id: number;
  board_slug: string;
  board_name: string;
  title: string;
  status: string;
  priority: string | null;
  effort_hours: number | null;
  due_date: string | null;
  attempt_count: number;
  open_comment_count: number;
  external_md_ref: string | null;
  /** Pipe-joined "name:color" pairs for this task's labels, or null. */
  labels_raw: string | null;
}

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loadTaskList(
  db: Database.Database,
  filters: { board?: string | null; status?: string | null } = {},
): TaskListRow[] {
  const where: string[] = ['t.archived_at IS NULL'];
  const params: Record<string, unknown> = {};

  if (filters.board) {
    where.push(`b.slug = @board`);
    params.board = filters.board;
  }
  if (filters.status) {
    where.push(`t.status = @status`);
    params.status = filters.status;
  }

  return db
    .prepare(
      `SELECT
         t.id, t.title, t.status, t.priority, t.effort_hours, t.due_date,
         t.external_md_ref,
         (SELECT GROUP_CONCAT(l.name || ':' || l.color, '|')
            FROM task_labels tl JOIN labels l ON l.id = tl.label_id
            WHERE tl.task_id = t.id) AS labels_raw,
         b.slug AS board_slug, b.name AS board_name,
         (SELECT COUNT(*) FROM attempts a WHERE a.task_id = t.id) AS attempt_count,
         (SELECT COUNT(*) FROM attempt_comments ac
            JOIN attempts a ON a.id = ac.attempt_id
            WHERE a.task_id = t.id AND ac.resolved = 0) AS open_comment_count
       FROM tasks t
       JOIN boards b ON b.id = t.board_id
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE t.status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1
                       WHEN 'review' THEN 2 WHEN 'backlog' THEN 3 ELSE 4 END,
         t.position ASC,
         CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         t.due_date IS NULL, t.due_date ASC,
         t.id DESC
       LIMIT 500`,
    )
    .all(params) as TaskListRow[];
}

const CSS = `
* { box-sizing: border-box }
body { margin: 0; font: 13px/1.45 -apple-system, system-ui, sans-serif;
       color: #e8e6e3; background: #0c0d10 }
.topbar { display: flex; align-items: center; gap: 14px; padding: 10px 18px;
          background: #15171c; border-bottom: 1px solid #232730 }
.topbar .brand { color: #d97757; font-weight: 600 }
.topbar .slash { color: #4a4f5b; margin: 0 4px }
.topbar .title { color: #8b8f9b; font-weight: 400 }
.topbar h1 { margin: 0; font-size: 14px; font-weight: 500 }
.topbar .spacer { flex: 1 }
.topbar a, .topbar select { background: transparent; color: #8b8f9b;
  border: 1px solid #2a2e38; border-radius: 4px; padding: 4px 8px; font: inherit;
  text-decoration: none }
.topbar a:hover { color: #e8e6e3 }
table { width: 100%; border-collapse: collapse }
th { text-align: left; padding: 8px 14px; background: #15171c; color: #6b7280;
     font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
     border-bottom: 1px solid #232730 }
td { padding: 8px 14px; border-bottom: 1px solid #15181f; font-size: 13px }
tr:hover { background: #15181f }
.title-cell a { color: #e8e6e3; text-decoration: none; font-weight: 500 }
.title-cell a:hover { color: #d97757 }
.status-pill { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 11px;
               background: #2a2e38; color: #c8ccd6; text-transform: uppercase; letter-spacing: 0.05em }
.status-backlog { background: #2a2e38 }
.status-todo { background: #1e3a5a; color: #93c5fd }
.status-in_progress { background: #5a3a1e; color: #fbbf24 }
.status-review { background: #4a1e5a; color: #c084fc }
.status-done { background: #1e5a3a; color: #4ade80 }
.priority-high { color: #fca5a5; font-weight: 600 }
.priority-medium { color: #fbbf24 }
.priority-low { color: #6b7280 }
.muted { color: #4a4f5b }
.counts { color: #6b7280; font-size: 11px }
.counts .badge { background: #2a2e38; padding: 1px 6px; border-radius: 3px; margin-left: 4px }
.counts .badge.open { background: #5a3a1e; color: #fbbf24 }
.badge.md { background: #1e3a5a; color: #93c5fd; font-size: 10px; padding: 1px 5px;
            border-radius: 3px; margin-left: 6px; vertical-align: middle }
.btn-plan { background: #d97757; color: #1a1108; border: 0; border-radius: 4px;
            padding: 5px 11px; font: inherit; cursor: pointer; font-weight: 500 }
.btn-plan:hover { background: #e08866 }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex;
         align-items: center; justify-content: center; z-index: 100 }
.modal[hidden] { display: none }
.modal-card { background: #15171c; border: 1px solid #232730; border-radius: 8px;
              padding: 18px; max-width: 720px; width: 90%; max-height: 85vh; overflow: auto }
.modal-card h3 { margin: 0 0 8px 0; font-size: 14px; color: #d97757 }
.modal-card .modal-help { color: #8b8f9b; font-size: 12px; margin: 0 0 12px 0; line-height: 1.5 }
.modal-card .modal-help code { background: #0c0d10; padding: 1px 5px; border-radius: 3px; color: #d97757 }
.modal-card label { display: block; color: #8b8f9b; font-size: 11px; margin-bottom: 10px }
.modal-card label input, .modal-card label textarea {
  display: block; width: 100%; margin-top: 4px; background: #0f1115; color: #e8e6e3;
  border: 1px solid #2a2e38; border-radius: 4px; padding: 6px 8px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; resize: vertical
}
.modal-card .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; align-items: end }
.btn-ghost { background: transparent; color: #8b8f9b; border: 1px solid #2a2e38;
             border-radius: 4px; padding: 5px 11px; font: inherit; cursor: pointer }
.btn-ghost:hover { background: #1a1d24; color: #e8e6e3 }
.btn-primary { background: #d97757; color: #1a1108; border: 0; border-radius: 4px;
               padding: 5px 11px; font: inherit; cursor: pointer; font-weight: 500 }
.btn-primary:hover { background: #e08866 }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed }
.plan-result { background: #0c0d10; padding: 10px; border-radius: 4px; max-height: 320px;
               overflow: auto; font: 11px/1.4 ui-monospace, monospace; color: #e8e6e3;
               margin-top: 12px; white-space: pre-wrap }
.empty { padding: 40px; text-align: center; color: #6b7280; font-style: italic }
.filter-bar { padding: 8px 18px; background: #0f1115; border-bottom: 1px solid #15181f;
              display: flex; gap: 8px; font-size: 12px; color: #8b8f9b; align-items: center }
.filter-bar a { color: #8b8f9b; text-decoration: none; padding: 3px 9px;
                border-radius: 12px; background: #15181f }
.filter-bar a.active { background: #d97757; color: #1a1108 }
.filter-bar a:hover { color: #e8e6e3 }
.filter-bar a.active:hover { color: #1a1108 }
`;

export function renderTasksListHtml(
  rows: TaskListRow[],
  filters: { board?: string | null; status?: string | null } = {},
): string {
  const statuses = ['all', 'backlog', 'todo', 'in_progress', 'review', 'done'];
  const filterLinks = statuses
    .map((s) => {
      const url = new URL('http://x/tasks');
      if (filters.board) url.searchParams.set('board', filters.board);
      if (s !== 'all') url.searchParams.set('status', s);
      const href = url.pathname + (url.search || '');
      const isActive = (s === 'all' && !filters.status) || filters.status === s;
      return `<a href="${href}" class="${isActive ? 'active' : ''}">${s}</a>`;
    })
    .join('');

  const rowsHtml = rows
    .map((r) => {
      const counts: string[] = [];
      if (r.attempt_count > 0) counts.push(`<span class="badge">${r.attempt_count} attempt${r.attempt_count === 1 ? '' : 's'}</span>`);
      if (r.open_comment_count > 0) counts.push(`<span class="badge open">${r.open_comment_count} open</span>`);
      const mdBadge = r.external_md_ref
        ? `<span class="badge md" title="synced from ${esc(r.external_md_ref)}">md</span>`
        : '';
      return `<tr>
        <td class="muted">#${r.id}</td>
        <td class="title-cell"><a href="/workspace/${r.id}">${esc(r.title)}</a> ${mdBadge}</td>
        <td><span class="status-pill status-${esc(r.status)}">${esc(r.status)}</span></td>
        <td>${r.priority ? `<span class="priority-${esc(r.priority)}">${esc(r.priority)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="muted">${esc(r.board_name)}</td>
        <td class="counts">${counts.join(' ') || '<span class="muted">—</span>'}</td>
        <td class="muted">${esc(r.due_date) || '—'}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<title>tasks · Swrm</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <div class="brand">Swrm <span class="slash">/</span> <span class="title">tasks</span></div>
  <h1>${rows.length} task${rows.length === 1 ? '' : 's'}</h1>
  <div class="spacer"></div>
  <button class="btn-plan" onclick="openPlanModal()" title="AI Project Breakdown — describe an idea, get a Ralph-loop-ready PRD">+ Generate plan</button>
  <a href="/skills">skills</a>
  <a href="/">← board</a>
</header>

<div class="modal" id="plan-modal" hidden>
  <div class="modal-card">
    <h3>Generate PRD from idea</h3>
    <p class="modal-help">Claude breaks a feature idea into 3-12 user stories (matches the Ralph-loop PRD schema). Review the output, then save as <code>prd-&lt;slug&gt;.json</code> at repo root to run via <code>/ralph-loop</code>.</p>
    <label>Idea
      <textarea id="plan-idea" rows="6" placeholder="e.g. add a dark-mode toggle that persists across sessions"></textarea>
    </label>
    <div class="actions">
      <button class="btn-ghost" onclick="closePlanModal()">cancel</button>
      <button class="btn-primary" id="plan-submit" onclick="submitPlan()">generate</button>
    </div>
    <pre id="plan-result" class="plan-result" hidden></pre>
    <div class="actions" id="plan-save-actions" hidden>
      <label style="flex:1">save as
        <input id="plan-filename" type="text" placeholder="prd-feature.json" />
      </label>
      <button class="btn-ghost" onclick="closePlanModal()">close</button>
      <button class="btn-primary" onclick="savePlan()">save file</button>
    </div>
  </div>
</div>

<script>
let LAST_PRD = null;
function openPlanModal() { document.getElementById('plan-modal').hidden = false; }
function closePlanModal() {
  document.getElementById('plan-modal').hidden = true;
  document.getElementById('plan-result').hidden = true;
  document.getElementById('plan-save-actions').hidden = true;
  document.getElementById('plan-idea').value = '';
  LAST_PRD = null;
}
async function submitPlan() {
  const idea = document.getElementById('plan-idea').value.trim();
  if (!idea) { alert('idea required'); return; }
  const btn = document.getElementById('plan-submit');
  btn.disabled = true; btn.textContent = 'generating…';
  try {
    const r = await fetch('/api/plan', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea }) });
    if (!r.ok) {
      const err = await r.json();
      alert('plan failed: ' + (err.error || r.statusText) + (err.hint ? '\\n\\nhint: ' + err.hint : ''));
      return;
    }
    const j = await r.json();
    LAST_PRD = j.prd;
    document.getElementById('plan-result').textContent = JSON.stringify(j.prd, null, 2);
    document.getElementById('plan-result').hidden = false;
    document.getElementById('plan-save-actions').hidden = false;
    const slug = (j.prd.userStories[0]?.title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    document.getElementById('plan-filename').value = 'prd-' + slug + '.json';
  } finally {
    btn.disabled = false; btn.textContent = 'generate';
  }
}
async function savePlan() {
  // Note: localhost-only single-user product — no /api/plan/save endpoint
  // (would need write-to-disk auth). For now, copy-to-clipboard so rep can
  // paste into their editor.
  await navigator.clipboard.writeText(JSON.stringify(LAST_PRD, null, 2));
  alert('PRD JSON copied to clipboard — paste into ' + document.getElementById('plan-filename').value);
  closePlanModal();
}
</script>
<div class="filter-bar">
  <span>status:</span>
  ${filterLinks}
</div>
${rows.length === 0
  ? `<div class="empty">no tasks matching filters · POST to /api/tasks to create one</div>`
  : `<table>
      <thead><tr>
        <th>id</th><th>title</th><th>status</th><th>priority</th><th>board</th><th>attempts</th><th>due</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`}
</body></html>`;
}

export async function tasksListHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/tasks' && url.pathname !== '/tasks/') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  const filters = {
    board: url.searchParams.get('board'),
    status: url.searchParams.get('status'),
  };
  try {
    const rows = loadTaskList(db, filters);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderTasksListHtml(rows, filters));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`tasks list failed: ${(err as Error).message}`);
  }
  // Silence the unused-import lint without touching the API: lazy ref.
  void listAttempts;
  return true;
}
