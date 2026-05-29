// swrm/src/views/settings.ts — GET /settings
// Preferences area: per-board color + workflow (column set + order).
// Deliberately minimal — a color swatch and a checkbox-ordered status
// list per board. No global theme, no font/layout knobs.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { listProjects, ProjectRow } from '../api/projects';
import { ALLOWED_STATUSES, parseWorkflow } from '../api/board_prefs';
import { resolveProject } from '../lib/project_context';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface BoardRow {
  id: number;
  slug: string;
  name: string;
  color: string;
  workflow: string;
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
.wrap { max-width: 760px; margin: 0 auto; padding: 24px 18px }
h1 { font-size: 16px; margin: 0 0 4px }
.sub { color: #6b7280; font-size: 12px; margin: 0 0 20px }
.board-card { background: #0f1115; border: 1px solid #1f232c; border-radius: 8px; padding: 16px; margin-bottom: 14px }
.board-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px }
.swatch { width: 22px; height: 22px; border-radius: 5px; border: 1px solid #2a2e38; flex: none }
.board-name { font-size: 14px; font-weight: 600 }
.board-slug { color: #4a4f5b; font-size: 11px; font-family: ui-monospace, monospace }
.field { margin-bottom: 12px }
.field > label { display: block; color: #8b8f9b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px }
input[type=color] { width: 44px; height: 28px; padding: 0; border: 1px solid #2a2e38; border-radius: 4px; background: #0c0d10; cursor: pointer; vertical-align: middle }
input[type=text] { background: #0c0d10; color: #e8e6e3; border: 1px solid #2a2e38; border-radius: 4px; padding: 5px 8px; font: inherit; width: 240px }
.wf-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center }
.wf-chip { display: inline-flex; align-items: center; gap: 4px; background: #15181f; border: 1px solid #2a2e38; border-radius: 14px; padding: 3px 8px 3px 10px; font-size: 12px }
.wf-chip input { margin: 0 }
.wf-chip.on { border-color: #d97757; color: #e8e6e3 }
.wf-chip.off { opacity: 0.5 }
.wf-note { color: #4a4f5b; font-size: 11px; margin-top: 6px }
.actions { margin-top: 14px }
.btn { background: #d97757; color: #1a1108; border: 0; border-radius: 4px; padding: 6px 13px; font: inherit; font-weight: 500; cursor: pointer }
.btn:hover { background: #e08866 }
.btn:disabled { opacity: 0.5; cursor: not-allowed }
#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px; border-radius: 6px; font-size: 12px; z-index: 200; box-shadow: 0 6px 20px rgba(0,0,0,0.4) }
#toast[hidden] { display: none }
.toast-error { background: #391a1a; color: #fca5a5 }
.toast-success { background: #15321e; color: #4ade80 }
.section-head { font-size: 13px; font-weight: 600; margin: 24px 0 10px; color: #e8e6e3 }
.add-project-form { background: #0f1115; border: 1px solid #1f232c; border-radius: 8px; padding: 16px; margin-bottom: 14px }
.add-project-form .field { margin-bottom: 12px }
.add-project-form .field > label { display: block; color: #8b8f9b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px }
.add-project-form .hint { color: #4a4f5b; font-size: 11px; margin-top: 4px }
`;

export function renderSettingsHtml(
  boards: BoardRow[],
  allProjects: { slug: string; name: string }[] = [],
  activeProjectSlug?: string,
): string {
  const projectSwitcher = allProjects.length > 1
    ? `<select onchange="(function(v){var u=new URL(location.href);u.searchParams.set('project',v);location.href=u.toString();})(this.value)" style="background:#1a1d24;color:#e8e6e3;border:1px solid #2a2e38;border-radius:4px;padding:4px 8px;font:inherit">
        ${allProjects.map((p) => `<option value="${esc(p.slug)}"${p.slug === activeProjectSlug ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>`
    : '';

  const cardsHtml = boards
    .map((b) => {
      const wf = parseWorkflow(b.workflow);
      const chips = ALLOWED_STATUSES.map((s) => {
        const on = wf.includes(s);
        const order = on ? wf.indexOf(s) + 1 : '';
        return `<label class="wf-chip ${on ? 'on' : 'off'}" data-status="${s}">
          <input type="checkbox" ${on ? 'checked' : ''} data-status="${s}" />
          ${esc(s)}${on ? ` <span class="wf-order">#${order}</span>` : ''}
        </label>`;
      }).join('');
      return `<div class="board-card" data-board-id="${b.id}">
        <div class="board-head">
          <span class="swatch" style="background:${esc(b.color)}"></span>
          <span class="board-name">${esc(b.name)}</span>
          <span class="board-slug">${esc(b.slug)}</span>
        </div>
        <div class="field">
          <label>Accent color</label>
          <input type="color" value="${esc(b.color)}" data-field="color" />
          <input type="text" value="${esc(b.color)}" data-field="color-hex" style="width:100px;margin-left:8px" />
        </div>
        <div class="field">
          <label>Workflow columns (check to include; order = check order)</label>
          <div class="wf-row">${chips}</div>
          <div class="wf-note">At least one column required. Drops to "in_progress" spawn an agent on the board view.</div>
        </div>
        <div class="actions">
          <button class="btn" data-save="${b.id}">Save board</button>
        </div>
      </div>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><title>settings · Swrm</title><style>${CSS}</style></head><body>
<header class="topbar">
  <div class="brand">Swrm <span class="slash">/</span> <span class="title">settings</span></div>
  ${projectSwitcher}
  <div class="spacer"></div>
  <a href="/">home</a><a href="/tasks">tasks</a><a href="/board">board</a><a href="/skills">skills</a>
</header>
<div class="wrap">
  <h1>Preferences</h1>
  <p class="sub">Per-board color + workflow. Changes apply to the kanban at /board.</p>
  ${cardsHtml || '<p class="sub">No boards yet.</p>'}
  <div class="section-head">Add project</div>
  <div class="add-project-form">
    <div class="field">
      <label>Name</label>
      <input type="text" id="proj-name" placeholder="My Project" />
    </div>
    <div class="field">
      <label>Slug <span style="font-weight:400;text-transform:none">(unique, lowercase, e.g. my-project)</span></label>
      <input type="text" id="proj-slug" placeholder="my-project" style="font-family:ui-monospace,monospace" />
      <div class="hint">Slugs are global and unique — they identify the project in URLs via ?project=&lt;slug&gt;.</div>
    </div>
    <div class="field">
      <label>Root path <span style="font-weight:400;text-transform:none">(absolute path to the project directory)</span></label>
      <input type="text" id="proj-root" placeholder="/Users/me/projects/my-project" style="width:100%" />
    </div>
    <div class="actions">
      <button class="btn" id="add-project-btn" onclick="addProject()">Add project</button>
    </div>
  </div>
</div>
<div id="toast" hidden></div>
<script>
let toastTimer = null;
function showToast(msg, level) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast-' + (level || 'success'); el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// keep color picker + hex text in sync within a card
document.addEventListener('input', (e) => {
  const card = e.target.closest('.board-card');
  if (!card) return;
  if (e.target.dataset.field === 'color') {
    card.querySelector('[data-field=color-hex]').value = e.target.value;
    card.querySelector('.swatch').style.background = e.target.value;
  }
  if (e.target.dataset.field === 'color-hex' && /^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
    card.querySelector('[data-field=color]').value = e.target.value;
    card.querySelector('.swatch').style.background = e.target.value;
  }
});

async function addProject() {
  const btn = document.getElementById('add-project-btn');
  const name = document.getElementById('proj-name').value.trim();
  const slug = document.getElementById('proj-slug').value.trim();
  const root_path = document.getElementById('proj-root').value.trim();
  if (!name || !slug || !root_path) { showToast('name, slug, and root path are required', 'error'); return; }
  btn.disabled = true;
  try {
    const r = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug, root_path }),
    });
    if (!r.ok) { const j = await r.json(); showToast('add failed: ' + (j.error || r.statusText), 'error'); return; }
    showToast('project added', 'success');
    setTimeout(() => location.reload(), 700);
  } finally { btn.disabled = false; }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const card = btn.closest('.board-card');
  const id = card.dataset.boardId;
  const color = card.querySelector('[data-field=color]').value;
  // Workflow: status keys in DOM order of CHECKED boxes.
  const workflow = Array.from(card.querySelectorAll('.wf-chip input:checked')).map((i) => i.dataset.status);
  if (workflow.length === 0) { showToast('pick at least one column', 'error'); return; }
  btn.disabled = true;
  try {
    const r = await fetch('/api/boards/' + id + '/prefs', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color, workflow }),
    });
    if (!r.ok) { const j = await r.json(); showToast('save failed: ' + (j.error || r.statusText), 'error'); return; }
    showToast('saved', 'success');
    setTimeout(() => location.reload(), 700);
  } finally { btn.disabled = false; }
});
</script>
</body></html>`;
}

const SETTINGS_RE = /^\/settings\/?$/;

export async function settingsHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!SETTINGS_RE.test(reqUrl.pathname)) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  const allProjects = listProjects(db);
  const activeProject = resolveProject(db, reqUrl);
  const boards = db
    .prepare(`SELECT id, slug, name, color, workflow FROM boards WHERE project_id = ? ORDER BY position, id`)
    .all(activeProject.id) as BoardRow[];
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderSettingsHtml(
    boards,
    allProjects.map((p) => ({ slug: p.slug, name: p.name })),
    activeProject.slug,
  ));
  return true;
}
