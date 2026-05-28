// loom/src/views/board.ts — GET /board
// Status-grouped kanban with drag-to-execute (vibecoderplanner pattern).
// Drag a card into "In Progress" → PATCH status + spawn an auto-run
// attempt. Drops to other columns just PATCH the status. /tasks remains
// the filterable table; /board is the drag-first surface.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { loadTaskList } from './tasks_list';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const COLUMNS: { key: string; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'Todo' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

const CSS = `
* { box-sizing: border-box }
body { margin: 0; font: 13px/1.45 -apple-system, system-ui, sans-serif; color: #e8e6e3; background: #0c0d10 }
.topbar { display: flex; align-items: center; gap: 12px; padding: 10px 18px; background: #15171c; border-bottom: 1px solid #232730 }
.topbar .brand { color: #d97757; font-weight: 600 }
.topbar .slash { color: #4a4f5b; margin: 0 4px }
.topbar .title { color: #8b8f9b }
.topbar .spacer { flex: 1 }
.topbar a { color: #8b8f9b; text-decoration: none; border: 1px solid #2a2e38; border-radius: 4px; padding: 4px 9px }
.topbar a:hover { color: #e8e6e3 }
.board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; padding: 16px; align-items: start }
.col { background: #0f1115; border: 1px solid #1f232c; border-radius: 8px; min-height: 200px; display: flex; flex-direction: column }
.col.drag-over { border-color: #d97757; background: #15120e }
.col-head { display: flex; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #1f232c }
.col-head h2 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: #8b8f9b; font-weight: 600 }
.col-head .n { color: #4a4f5b; font-size: 11px }
.col-body { padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 80px }
.card { background: #15181f; border: 1px solid #232730; border-radius: 6px; padding: 9px 10px; cursor: grab }
.card:active { cursor: grabbing }
.card.dragging { opacity: 0.4 }
.card .id { color: #4a4f5b; font-size: 10px }
.card .title { color: #e8e6e3; font-size: 13px; margin: 2px 0 4px }
.card .title a { color: inherit; text-decoration: none }
.card .title a:hover { color: #d97757 }
.card .meta { display: flex; gap: 6px; flex-wrap: wrap }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #2a2e38; color: #c8ccd6 }
.badge.open { background: #5a3a1e; color: #fbbf24 }
.badge.pri-high { background: #391a1a; color: #fca5a5 }
.badge.pri-medium { background: #5a3a1e; color: #fbbf24 }
.badge.pri-low { background: #2a2e38; color: #8b8f9b }
.empty { color: #4a4f5b; font-size: 11px; text-align: center; padding: 16px 8px; font-style: italic }
#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px; border-radius: 6px; font-size: 12px; z-index: 200; box-shadow: 0 6px 20px rgba(0,0,0,0.4) }
#toast[hidden] { display: none }
.toast-error { background: #391a1a; color: #fca5a5 }
.toast-info { background: #1e3a5a; color: #93c5fd }
.toast-success { background: #15321e; color: #4ade80 }
.touch-note { display: none; color: #6b7280; font-size: 11px; padding: 4px 18px }
@media (hover: none) { .touch-note { display: block } .card { cursor: default } }
`;

interface Row {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  attempt_count: number;
  open_comment_count: number;
}

export function renderBoardHtml(rows: Row[]): string {
  const byStatus = new Map<string, Row[]>();
  for (const c of COLUMNS) byStatus.set(c.key, []);
  for (const r of rows) {
    const bucket = byStatus.get(r.status) ?? byStatus.get('backlog')!;
    bucket.push(r);
  }

  const colsHtml = COLUMNS.map((col) => {
    const cards = (byStatus.get(col.key) ?? [])
      .map((r) => {
        const badges: string[] = [];
        if (r.priority) badges.push(`<span class="badge pri-${esc(r.priority)}">${esc(r.priority)}</span>`);
        if (r.attempt_count > 0) badges.push(`<span class="badge">${r.attempt_count} att</span>`);
        if (r.open_comment_count > 0) badges.push(`<span class="badge open">${r.open_comment_count} open</span>`);
        return `<article class="card" draggable="true" data-task-id="${r.id}" data-status="${esc(r.status)}">
          <div class="id">#${r.id}</div>
          <div class="title"><a href="/workspace/${r.id}">${esc(r.title)}</a></div>
          ${badges.length ? `<div class="meta">${badges.join('')}</div>` : ''}
        </article>`;
      })
      .join('');
    const body = cards || '<div class="empty">— empty —</div>';
    return `<section class="col" data-col="${col.key}">
      <header class="col-head"><h2>${col.label}</h2><span class="n">${(byStatus.get(col.key) ?? []).length}</span></header>
      <div class="col-body">${body}</div>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><title>board · Loom</title><style>${CSS}</style></head><body>
<header class="topbar">
  <div class="brand">Loom <span class="slash">/</span> <span class="title">board</span></div>
  <div class="spacer"></div>
  <a href="/">home</a>
  <a href="/tasks">tasks</a>
</header>
<div class="touch-note">Drag-to-execute is disabled on touch devices — open a task and use the Spawn button.</div>
<main class="board">${colsHtml}</main>
<div id="toast" hidden></div>
<script>
let toastTimer = null;
function showToast(msg, level) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast-' + (level || 'info'); el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const isTouch = window.matchMedia('(hover: none)').matches;
let dragCardId = null;
let dragFromStatus = null;
let confirmedSpawn = false;

if (!isTouch) {
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    dragCardId = Number(card.dataset.taskId);
    dragFromStatus = card.dataset.status;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragend', (e) => {
    const card = e.target.closest('.card');
    if (card) card.classList.remove('dragging');
  });
  document.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const target = col.dataset.col;
      if (dragCardId == null || target === dragFromStatus) return;
      await moveTask(dragCardId, dragFromStatus, target);
      dragCardId = null; dragFromStatus = null;
    });
  });
}

async function moveTask(taskId, fromStatus, toStatus) {
  // Always patch status first.
  const patchRes = await fetch('/api/tasks/' + taskId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: toStatus }),
  });
  if (!patchRes.ok) { showToast('move failed: ' + (await patchRes.text()), 'error'); return; }

  if (toStatus === 'in_progress') {
    if (!confirmedSpawn) {
      const ok = confirm('Spawn an agent attempt for task #' + taskId + ' immediately?');
      if (ok) confirmedSpawn = true;
      else { showToast('moved to In Progress (no attempt spawned)', 'info'); setTimeout(() => location.reload(), 600); return; }
    }
    const spawnRes = await fetch('/api/tasks/' + taskId + '/attempts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_run: true }),
    });
    if (!spawnRes.ok) { showToast('status moved but spawn failed: ' + (await spawnRes.text()), 'error'); }
    else { const j = await spawnRes.json(); showToast('spawned attempt #' + (j.attempt ? j.attempt.attempt_number : '?'), 'success'); }
  } else {
    showToast('moved to ' + toStatus, 'success');
  }
  setTimeout(() => location.reload(), 700);
}
</script>
</body></html>`;
}

const BOARD_RE = /^\/board\/?$/;

export async function boardHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0];
  if (!BOARD_RE.test(url)) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  const rows = loadTaskList(db) as unknown as Row[];
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderBoardHtml(rows));
  return true;
}
