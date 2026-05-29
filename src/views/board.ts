// swrm/src/views/board.ts — GET /board
// Status-grouped kanban with drag-to-execute (vibecoderplanner pattern).
// Drag a card into "In Progress" → PATCH status + spawn an auto-run
// attempt. Drops to other columns just PATCH the status. /tasks remains
// the filterable table; /board is the drag-first surface.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { loadTaskList } from './tasks_list';
import { parseWorkflow } from '../api/board_prefs';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse the pipe-joined "name:color" pairs from loadTaskList's `labels_raw`
 * into chip data. Splits each fragment on the LAST colon so label names may
 * themselves contain colons; fragments without a valid #hex color are skipped.
 */
export function parseLabels(raw: string | null | undefined): { name: string; color: string }[] {
  if (!raw) return [];
  const out: { name: string; color: string }[] = [];
  for (const frag of raw.split('|')) {
    const i = frag.lastIndexOf(':');
    if (i <= 0) continue;
    const name = frag.slice(0, i).trim();
    const color = frag.slice(i + 1).trim();
    if (name && /^#[0-9a-fA-F]{3,8}$/.test(color)) out.push({ name, color });
  }
  return out;
}

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
  shipped: 'Shipped',
};

function columnsFor(workflow: string[]): { key: string; label: string }[] {
  return workflow.map((key) => ({ key, label: STATUS_LABELS[key] ?? key }));
}

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
/* Priority reads at a glance from the left stripe — distinct hues, no green
   (green is reserved for the done column / success states elsewhere). */
.card.card-pri-high { border-left: 3px solid #ef5350 }
.card.card-pri-medium { border-left: 3px solid #fb923c }
.card.card-pri-low { border-left: 3px solid #3a3f4b }
.card .id { color: #4a4f5b; font-size: 10px }
.card .title { color: #e8e6e3; font-size: 13px; margin: 2px 0 4px }
.card .title a { color: inherit; text-decoration: none }
.card .title a:hover { color: #d97757 }
.card .labels { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 4px }
.card .meta { display: flex; gap: 6px; flex-wrap: wrap }
.label-chip { font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid;
              background: transparent; font-weight: 500 }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #2a2e38; color: #c8ccd6 }
.badge.open { background: #5a3a1e; color: #fbbf24 }
.badge.pri-high { background: #391a1a; color: #fca5a5 }
/* orange, not the #fbbf24 yellow the open-comment badge uses — they collided */
.badge.pri-medium { background: #4a2f12; color: #fb923c }
.badge.pri-low { background: #2a2e38; color: #8b8f9b }
.empty { color: #4a4f5b; font-size: 11px; text-align: center; padding: 16px 8px; font-style: italic }
#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px; border-radius: 6px; font-size: 12px; z-index: 200; box-shadow: 0 6px 20px rgba(0,0,0,0.4) }
#toast[hidden] { display: none }
.toast-error { background: #391a1a; color: #fca5a5 }
.toast-info { background: #1e3a5a; color: #93c5fd }
.toast-success { background: #15321e; color: #4ade80 }
.touch-note { display: none; color: #6b7280; font-size: 11px; padding: 4px 18px }
@media (hover: none) { .touch-note { display: block } .card { cursor: default } .card-move { opacity: 1 } }
.card-move { display: flex; gap: 4px; margin-top: 6px; opacity: 0; transition: opacity .12s }
.card:hover .card-move { opacity: 1 }
.mv { background: #1a1d24; color: #8b8f9b; border: 1px solid #2a2e38; border-radius: 3px;
      font-size: 11px; line-height: 1; padding: 2px 7px; cursor: pointer }
.mv:hover { color: #e8e6e3; border-color: #3a3f4b }
.topbar-btn { background: transparent; color: #8b8f9b; border: 1px solid #2a2e38; border-radius: 4px;
              padding: 4px 9px; font: inherit; cursor: pointer }
.topbar-btn:hover { color: #e8e6e3 }
.quick-add { width: 100%; background: #0f1115; color: #e8e6e3; border: 1px dashed #2a2e38;
             border-radius: 5px; padding: 7px 9px; font: inherit; margin-bottom: 8px }
.quick-add[hidden] { display: none }
.quick-add:focus { outline: none; border-color: #d97757; border-style: solid }
dialog.legend { background: #15171c; color: #e8e6e3; border: 1px solid #232730; border-radius: 10px;
                max-width: 440px; width: 90%; padding: 18px 20px; box-shadow: 0 12px 48px rgba(0,0,0,0.5) }
dialog.legend::backdrop { background: rgba(0,0,0,0.6) }
dialog.legend h3 { margin: 0 0 4px; font-size: 14px }
dialog.legend h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b8f9b }
dialog.legend .dim { color: #6b7280; font-weight: 400; font-size: 11px }
.lg-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; color: #c8ccd6 }
.lg-row .stripe { width: 12px; height: 12px; border-radius: 2px; flex: none }
.lg-row .stripe.hi { background: #ef5350 } .lg-row .stripe.med { background: #fb923c } .lg-row .stripe.lo { background: #3a3f4b }
.lg-row kbd { background: #0c0d10; border: 1px solid #2a2e38; border-radius: 3px; padding: 1px 6px; font: 11px ui-monospace, monospace }
dialog.legend .btn-ghost { margin-top: 16px; background: transparent; color: #8b8f9b; border: 1px solid #2a2e38; border-radius: 4px; padding: 5px 11px; cursor: pointer; font: inherit }
`;

interface Row {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  attempt_count: number;
  open_comment_count: number;
  labels_raw?: string | null;
}

export interface BoardViewOpts {
  /** Ordered status keys → columns. Defaults to the canonical five. */
  workflow?: string[];
  /** Board accent color (hex). Defaults to copper. */
  color?: string;
  /** Active board slug (for the switcher + spawn scoping). */
  activeSlug?: string;
  /** All boards for the switcher dropdown. */
  boards?: { slug: string; name: string }[];
  /** All labels (name+color) for the legend reference panel. */
  legendLabels?: { name: string; color: string }[];
  /** Active board id — quick-add posts new tasks onto this board. */
  activeBoardId?: number;
}

export function renderBoardHtml(rows: Row[], opts: BoardViewOpts = {}): string {
  const workflow = opts.workflow && opts.workflow.length > 0
    ? opts.workflow
    : ['backlog', 'todo', 'in_progress', 'review', 'done'];
  const COLUMNS = columnsFor(workflow);
  const accent = opts.color && /^#[0-9a-fA-F]{6}$/.test(opts.color) ? opts.color : '#d97757';
  const firstCol = COLUMNS[0]?.key ?? 'backlog';

  const byStatus = new Map<string, Row[]>();
  for (const c of COLUMNS) byStatus.set(c.key, []);
  for (const r of rows) {
    // Tasks whose status isn't in this board's workflow fall into the first column.
    const bucket = byStatus.get(r.status) ?? byStatus.get(firstCol)!;
    bucket.push(r);
  }

  const switcher = (opts.boards && opts.boards.length > 1)
    ? `<select onchange="location.href='/board?board='+this.value" style="background:#1a1d24;color:#e8e6e3;border:1px solid #2a2e38;border-radius:4px;padding:4px 8px;font:inherit">
        ${opts.boards.map((b) => `<option value="${esc(b.slug)}"${b.slug === opts.activeSlug ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
      </select>`
    : '';

  const labelRows = (opts.legendLabels ?? [])
    .map((l) => `<div class="lg-row"><span class="label-chip" style="color:${esc(l.color)};border-color:${esc(l.color)}">${esc(l.name)}</span></div>`)
    .join('') || '<div class="lg-row dim">no labels yet</div>';
  const legendDialog = `<dialog id="legend" class="legend">
    <h3>Legend <span class="dim">· press Esc to close</span></h3>
    <h4>Priority (card stripe)</h4>
    <div class="lg-row"><span class="stripe hi"></span> high</div>
    <div class="lg-row"><span class="stripe med"></span> medium</div>
    <div class="lg-row"><span class="stripe lo"></span> low</div>
    <h4>Labels</h4>
    ${labelRows}
    <h4>Badges</h4>
    <div class="lg-row"><span class="badge">N att</span> agent attempts run on this task</div>
    <div class="lg-row"><span class="badge open">N open</span> unresolved review comments</div>
    <h4>Keyboard &amp; moves</h4>
    <div class="lg-row"><kbd>?</kbd> toggle this panel</div>
    <div class="lg-row"><kbd>n</kbd> new task in the first column</div>
    <div class="lg-row">↑ / ↓ on a card reorder it · drag a card to another column to change status</div>
    <form method="dialog"><button class="btn-ghost">close</button></form>
  </dialog>`;

  const colsHtml = COLUMNS.map((col) => {
    const cards = (byStatus.get(col.key) ?? [])
      .map((r) => {
        const badges: string[] = [];
        if (r.priority) badges.push(`<span class="badge pri-${esc(r.priority)}">${esc(r.priority)}</span>`);
        if (r.attempt_count > 0) badges.push(`<span class="badge">${r.attempt_count} att</span>`);
        if (r.open_comment_count > 0) badges.push(`<span class="badge open">${r.open_comment_count} open</span>`);
        const chips = parseLabels(r.labels_raw)
          .map((l) => `<span class="label-chip" style="color:${esc(l.color)};border-color:${esc(l.color)}">${esc(l.name)}</span>`)
          .join('');
        const cardClass = r.priority ? `card card-pri-${esc(r.priority)}` : 'card';
        return `<article class="${cardClass}" draggable="true" data-task-id="${r.id}" data-status="${esc(r.status)}">
          <div class="id">#${r.id}</div>
          <div class="title"><a href="/workspace/${r.id}">${esc(r.title)}</a></div>
          ${chips ? `<div class="labels">${chips}</div>` : ''}
          ${badges.length ? `<div class="meta">${badges.join('')}</div>` : ''}
          <div class="card-move">
            <button class="mv" data-dir="up" data-id="${r.id}" draggable="false" title="Move up" aria-label="Move up">↑</button>
            <button class="mv" data-dir="down" data-id="${r.id}" draggable="false" title="Move down" aria-label="Move down">↓</button>
          </div>
        </article>`;
      })
      .join('');
    const body = cards || '<div class="empty">— empty —</div>';
    const quickAdd = col.key === firstCol
      ? `<input class="quick-add" id="quick-add" hidden placeholder="New task title — Enter to add, Esc to cancel" />`
      : '';
    return `<section class="col" data-col="${col.key}">
      <header class="col-head"><h2>${col.label}</h2><span class="n">${(byStatus.get(col.key) ?? []).length}</span></header>
      <div class="col-body">${quickAdd}${body}</div>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><title>board · Swrm</title><style>${CSS}
.board { grid-template-columns: repeat(${COLUMNS.length}, 1fr) !important }
.col.drag-over { border-color: ${accent} }
.card .title a:hover { color: ${accent} }
.col-head { border-bottom-color: ${accent}33 }
</style></head><body>
<header class="topbar">
  <div class="brand">Swrm <span class="slash">/</span> <span class="title">board</span></div>
  ${switcher}
  <div class="spacer"></div>
  <button class="topbar-btn" onclick="document.getElementById('legend').showModal()" title="Legend &amp; shortcuts (press ?)">⚡ legend</button>
  <a href="/">home</a>
  <a href="/tasks">tasks</a>
  <a href="/skills">skills</a>
  <a href="/settings">settings</a>
</header>
<div class="touch-note">Drag-to-execute is disabled on touch devices — open a task and use the Spawn button.</div>
<main class="board">${colsHtml}</main>
${legendDialog}
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

// ── reorder buttons (↑/↓) — swap position with the adjacent sibling ──
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mv');
  if (!btn) return;
  e.stopPropagation();
  const res = await fetch('/api/tasks/' + btn.dataset.id + '/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: btn.dataset.dir }),
  });
  if (!res.ok) { showToast('move failed', 'error'); return; }
  const j = await res.json();
  if (j.moved) location.reload(); else showToast('already at the edge', 'info');
});

// ── keyboard: ? toggles the legend, n opens quick-add ──
const ACTIVE_BOARD_ID = ${opts.activeBoardId ?? 'null'};
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape' && e.target.id === 'quick-add') { e.target.value = ''; e.target.hidden = true; e.target.blur(); }
    return;
  }
  const dlg = document.getElementById('legend');
  if (e.key === '?') { e.preventDefault(); dlg.open ? dlg.close() : dlg.showModal(); return; }
  if (e.key === 'n') {
    e.preventDefault();
    const qa = document.getElementById('quick-add');
    if (qa) { qa.hidden = false; qa.focus(); }
  }
});

// ── quick-add: Enter creates a backlog task on the active board ──
const quickAddEl = document.getElementById('quick-add');
if (quickAddEl) {
  quickAddEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const title = quickAddEl.value.trim();
    if (!title) { quickAddEl.hidden = true; return; }
    const body = { title: title, status: 'backlog' };
    if (ACTIVE_BOARD_ID != null) body.board_id = ACTIVE_BOARD_ID;
    const res = await fetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { showToast('add failed', 'error'); return; }
    location.reload();
  });
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
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!BOARD_RE.test(reqUrl.pathname)) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }

  const allBoards = db
    .prepare(`SELECT id, slug, name, color, workflow FROM boards ORDER BY position, id`)
    .all() as { id: number; slug: string; name: string; color: string; workflow: string }[];

  const wantSlug = reqUrl.searchParams.get('board');
  const active = (wantSlug && allBoards.find((b) => b.slug === wantSlug)) || allBoards[0];

  const legendLabels = db
    .prepare(`SELECT name, color FROM labels ORDER BY name`)
    .all() as { name: string; color: string }[];

  // Scope tasks to the active board when one exists; else show everything.
  const rows = (active
    ? loadTaskList(db, { board: active.slug })
    : loadTaskList(db)) as unknown as Row[];

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    renderBoardHtml(rows, {
      workflow: active ? parseWorkflow(active.workflow) : undefined,
      color: active?.color,
      activeSlug: active?.slug,
      activeBoardId: active?.id,
      boards: allBoards.map((b) => ({ slug: b.slug, name: b.name })),
      legendLabels,
    }),
  );
  return true;
}
