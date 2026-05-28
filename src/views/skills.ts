// swrm/src/views/skills.ts — GET /skills
// Read + run + pause surface for Skill Cards (Skill Mode). Editing a card is
// done in the Markdown file; this view lists status/schedule and offers
// "Run now" + enable/pause (both write back to the source card via the API).

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { listSkills } from '../api/skills';
import type { Skill } from '../skills/types';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
main { padding: 16px 18px; max-width: 1100px }
table { width: 100%; border-collapse: collapse }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b8f9b; padding: 8px 10px; border-bottom: 1px solid #232730 }
td { padding: 10px; border-bottom: 1px solid #16191f; vertical-align: middle }
.name { color: #e8e6e3; font-weight: 600 }
.sub { color: #6b7280; font-size: 11px }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: #2a2e38; color: #c8ccd6 }
.badge.read-only { background: #15321e; color: #4ade80 }
.badge.writes { background: #5a3a1e; color: #fbbf24 }
.badge.external { background: #391a1a; color: #fca5a5 }
.status-ok { color: #4ade80 } .status-error { color: #fca5a5 } .status-running { color: #93c5fd } .status-idle, .status-skipped { color: #6b7280 }
.paused { color: #6b7280; font-style: italic }
button { font: inherit; border: 1px solid #2a2e38; background: #1a1d24; color: #c8ccd6; border-radius: 4px; padding: 4px 9px; cursor: pointer }
button:hover { color: #e8e6e3; border-color: #d97757 }
.empty { color: #6b7280; padding: 40px 10px; text-align: center; font-style: italic }
#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px; border-radius: 6px; font-size: 12px; z-index: 200 }
#toast[hidden] { display: none }
.toast-error { background: #391a1a; color: #fca5a5 } .toast-info { background: #1e3a5a; color: #93c5fd } .toast-success { background: #15321e; color: #4ade80 }
`;

export function renderSkillsHtml(skills: Skill[]): string {
  const rows = skills
    .map((s) => {
      const statusCls = `status-${esc(s.last_status)}`;
      const enabledCell = s.enabled
        ? `<span class="status-ok">enabled</span>`
        : `<span class="paused">paused</span>`;
      return `<tr data-skill-id="${s.id}">
        <td><div class="name">${esc(s.name)}</div><div class="sub">${esc(s.project)} · ${esc(s.type)}</div></td>
        <td><span class="badge ${esc(s.side_effects)}">${esc(s.side_effects)}</span></td>
        <td><code class="sub">${esc(s.frequency)}</code></td>
        <td>${enabledCell}</td>
        <td class="${statusCls}">${esc(s.last_status)}</td>
        <td class="sub">${fmt(s.last_run)}</td>
        <td class="sub">${fmt(s.next_due)}</td>
        <td>
          <button class="run-now" data-id="${s.id}">Run now</button>
          <button class="toggle" data-id="${s.id}" data-enabled="${s.enabled ? 1 : 0}">${s.enabled ? 'Pause' : 'Enable'}</button>
        </td>
      </tr>`;
    })
    .join('');

  const body = skills.length
    ? `<table>
        <thead><tr><th>Skill</th><th>Effects</th><th>Frequency</th><th>State</th><th>Last status</th><th>Last run</th><th>Next due</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="empty">No skills yet. Drop a <code>*.skill.md</code> card in your skills dir, then reload.</div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><title>skills · Swrm</title><style>${CSS}</style></head><body>
<header class="topbar">
  <div class="brand">Swrm <span class="slash">/</span> <span class="title">skills</span></div>
  <div class="spacer"></div>
  <a href="/">home</a>
  <a href="/tasks">tasks</a>
  <a href="/board">board</a>
  <a href="/settings">settings</a>
</header>
<main>${body}</main>
<div id="toast" hidden></div>
<script>
let toastTimer = null;
function showToast(msg, level) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast-' + (level || 'info'); el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
document.querySelectorAll('.run-now').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.disabled = true; showToast('running…', 'info');
    const res = await fetch('/api/skills/' + btn.dataset.id + '/run', { method: 'POST' });
    if (!res.ok) { showToast('run failed: ' + (await res.text()), 'error'); btn.disabled = false; return; }
    showToast('done', 'success'); setTimeout(() => location.reload(), 700);
  });
});
document.querySelectorAll('.toggle').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const next = btn.dataset.enabled !== '1';
    const res = await fetch('/api/skills/' + btn.dataset.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) { showToast('toggle failed: ' + (await res.text()), 'error'); return; }
    showToast(next ? 'enabled' : 'paused', 'success'); setTimeout(() => location.reload(), 500);
  });
});
</script>
</body></html>`;
}

const SKILLS_RE = /^\/skills\/?$/;

export async function skillsViewHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = (req.url ?? '/').split('?')[0];
  if (!SKILLS_RE.test(url)) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderSkillsHtml(listSkills(db)));
  return true;
}
