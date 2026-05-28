// src/views/home.ts — GET / and /index.html
//
// The home page: first-60-seconds idea-input UX (stealing the
// vibecoderplanner.com flow). A centered hero with a big idea textarea +
// a single primary "Generate & Execute" button. POST /api/plan renders an
// inline PRD story preview; from there the rep can copy the JSON or kick off
// the first attempt via POST /api/plan/execute (wired in parallel).
//
// Pure render fn + a tiny GET-only handler. No DB read at render time, so
// the handler takes an optional db purely to match the sibling-view
// signature the server router calls with.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
* { box-sizing: border-box }
body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif;
       color: #e8e6e3; background: #0c0d10; min-height: 100vh;
       display: flex; flex-direction: column }
.topbar { display: flex; align-items: center; gap: 14px; padding: 10px 18px;
          background: #15171c; border-bottom: 1px solid #232730 }
.topbar .brand { color: #d97757; font-weight: 600 }
.topbar .slash { color: #4a4f5b; margin: 0 4px }
.topbar .title { color: #8b8f9b; font-weight: 400 }
.topbar .spacer { flex: 1 }
.topbar a { background: transparent; color: #8b8f9b; border: 1px solid #2a2e38;
            border-radius: 4px; padding: 4px 8px; font: inherit; text-decoration: none }
.topbar a:hover { color: #e8e6e3 }
main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px 18px }
.hero { width: 100%; max-width: 680px; text-align: center }
.wordmark { font-size: 34px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 6px 0 }
.wordmark .accent { color: #d97757 }
.tagline { color: #8b8f9b; font-size: 14px; margin: 0 0 28px 0 }
.idea-box { text-align: left }
#idea-input { width: 100%; min-height: 132px; background: #0f1115; color: #e8e6e3;
              border: 1px solid #2a2e38; border-radius: 8px; padding: 14px 16px;
              font: 15px/1.5 -apple-system, system-ui, sans-serif; resize: vertical }
#idea-input:focus { outline: none; border-color: #d97757 }
#idea-input:disabled { opacity: 0.55; cursor: not-allowed }
.action-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; justify-content: center }
.btn-primary { background: #d97757; color: #1a1108; border: 0; border-radius: 6px;
               padding: 10px 20px; font: 600 14px -apple-system, system-ui, sans-serif;
               cursor: pointer }
.btn-primary:hover { background: #e08866 }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed }
.btn-ghost { background: transparent; color: #8b8f9b; border: 1px solid #2a2e38;
             border-radius: 6px; padding: 10px 16px; font: 14px inherit; cursor: pointer; text-decoration: none }
.btn-ghost:hover { background: #1a1d24; color: #e8e6e3 }
.helper { color: #8b8f9b; font-size: 12px; margin-top: 12px; text-align: center; line-height: 1.5 }
.helper code { background: #0c0d10; padding: 1px 5px; border-radius: 3px; color: #d97757;
               font-family: ui-monospace, SFMono-Regular, monospace }
.helper a { color: #d97757; text-decoration: none }
.helper a:hover { text-decoration: underline }
.nav { margin-top: 26px; display: flex; gap: 14px; justify-content: center; font-size: 13px }
.nav a { color: #8b8f9b; text-decoration: none; padding: 4px 12px; border-radius: 12px; background: #15181f }
.nav a:hover { color: #e8e6e3 }
#plan-error { display: none; margin-top: 16px; padding: 10px 14px; border-radius: 6px;
              background: #391a1a; color: #fca5a5; border: 1px solid #5a2e2e;
              font-size: 13px; text-align: left }
#plan-error[data-shown="1"] { display: block }
#plan-preview { display: none; margin-top: 22px; text-align: left;
                background: #0f1115; border: 1px solid #232730; border-radius: 8px; padding: 16px }
#plan-preview[data-shown="1"] { display: block }
#plan-preview h2 { margin: 0 0 4px 0; font-size: 15px; color: #e8e6e3 }
#plan-preview .prd-desc { color: #8b8f9b; font-size: 12px; margin: 0 0 14px 0; line-height: 1.5 }
.story { padding: 10px 12px; background: #15181f; border-radius: 6px; margin-bottom: 8px;
         border-left: 3px solid #2a2e38 }
.story .story-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap }
.story .story-id { color: #d97757; font: 11px ui-monospace, SFMono-Regular, monospace }
.story .story-title { color: #e8e6e3; font-weight: 500; flex: 1; min-width: 0 }
.story .ac-count { color: #6b7280; font-size: 11px }
.badge.tech { background: #1e3a5a; color: #93c5fd; font-size: 10px; padding: 1px 6px;
              border-radius: 3px; margin-left: 4px }
.preview-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap }
#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px;
         border-radius: 6px; font-size: 12px; z-index: 200; max-width: 360px;
         box-shadow: 0 6px 20px rgba(0,0,0,0.4); transition: opacity .2s }
#toast[hidden] { opacity: 0; pointer-events: none }
.toast-error { background: #391a1a; color: #fca5a5; border: 1px solid #5a2e2e }
.toast-info { background: #1e3a5a; color: #93c5fd; border: 1px solid #2a4a6a }
.toast-success { background: #15321e; color: #4ade80; border: 1px solid #1e5a3a }
`;

export function renderHomeHtml(opts: { hasApiKey: boolean } = { hasApiKey: false }): string {
  const hasApiKey = opts.hasApiKey === true;
  const disabledAttr = hasApiKey ? '' : ' disabled';
  const helperLine = hasApiKey
    ? `Describe your build, then hit <b>Generate &amp; Execute</b> — Swrm breaks it into Ralph-loop-ready stories.`
    : `Set <code>ANTHROPIC_API_KEY</code> to use AI Breakdown — or go to <a href="/tasks">Tasks</a> to start manually.`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Swrm — describe what you want to build</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <div class="brand">Swrm <span class="slash">/</span> <span class="title">home</span></div>
  <div class="spacer"></div>
  <a href="/tasks">tasks</a>
  <a href="/board">board</a>
</header>
<main>
  <div class="hero">
    <h1 class="wordmark">sw<span class="accent">r</span>m</h1>
    <p class="tagline">Describe a feature. Get a plan. Spawn the first agent — in under a minute.</p>
    <div class="idea-box">
      <textarea id="idea-input" placeholder="Describe what you want to build…"${disabledAttr}></textarea>
    </div>
    <div class="action-row">
      <button class="btn-primary" id="generate-btn" onclick="generatePlan()"${disabledAttr}>Generate &amp; Execute</button>
    </div>
    <p class="helper" id="home-helper">${helperLine}</p>

    <div id="plan-error" role="alert"></div>

    <div id="plan-preview">
      <h2 id="prd-title"></h2>
      <p class="prd-desc" id="prd-desc"></p>
      <div id="story-list"></div>
      <div class="preview-actions">
        <button class="btn-ghost" id="copy-btn" onclick="copyPlan()">Save as prd-&lt;slug&gt;.json</button>
        <button class="btn-primary" id="execute-btn" onclick="saveAndSpawn()">Save &amp; spawn first attempt</button>
      </div>
    </div>

    <nav class="nav">
      <a href="/tasks">→ Tasks</a>
      <a href="/board">→ Board</a>
    </nav>
  </div>
</main>

<div id="toast" hidden></div>

<script>
const HAS_API_KEY = ${hasApiKey ? 'true' : 'false'};
let LAST_PRD = null;
let LAST_IDEA = '';

function showToast(msg, level) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast-' + (level || 'info');
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 3500);
}

function setError(msg) {
  const el = document.getElementById('plan-error');
  if (msg) { el.textContent = msg; el.dataset.shown = '1'; }
  else { el.textContent = ''; el.dataset.shown = '0'; }
}

function slugify(s) {
  return String(s || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'plan';
}

function escText(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function renderPreview(prd) {
  document.getElementById('prd-title').textContent = prd.project || 'Generated plan';
  document.getElementById('prd-desc').textContent = prd.description || '';
  const list = document.getElementById('story-list');
  list.innerHTML = '';
  const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
  for (const s of stories) {
    const ac = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.length : 0;
    const tech = s.tech_stack || s.techStack;
    const techBadge = tech ? '<span class="badge tech">' + escText(tech) + '</span>' : '';
    const row = document.createElement('div');
    row.className = 'story';
    row.innerHTML =
      '<div class="story-head">' +
        '<span class="story-id">' + escText(s.id || '') + '</span>' +
        '<span class="story-title">' + escText(s.title || '') + techBadge + '</span>' +
        '<span class="ac-count">' + ac + ' criteri' + (ac === 1 ? 'on' : 'a') + '</span>' +
      '</div>';
    list.appendChild(row);
  }
  document.getElementById('plan-preview').dataset.shown = '1';
}

async function generatePlan() {
  setError('');
  const idea = document.getElementById('idea-input').value.trim();
  if (!idea) { setError('Describe what you want to build first — the idea is required.'); return; }
  const btn = document.getElementById('generate-btn');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const r = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea }),
    });
    if (r.status === 503) {
      const j = await r.json().catch(() => ({}));
      setError((j.error || 'AI Breakdown unavailable') + (j.hint ? ' — ' + j.hint : ' — set ANTHROPIC_API_KEY and reboot Swrm.'));
      return;
    }
    if (r.status === 400) {
      const j = await r.json().catch(() => ({}));
      setError(j.error || 'The idea is required.');
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError('Plan failed: ' + (j.error || r.statusText));
      return;
    }
    const j = await r.json();
    LAST_PRD = j.prd;
    LAST_IDEA = idea;
    renderPreview(j.prd);
  } catch (e) {
    setError('Network error: ' + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = !HAS_API_KEY; btn.textContent = 'Generate & Execute';
  }
}

async function copyPlan() {
  if (!LAST_PRD) return;
  const json = JSON.stringify(LAST_PRD, null, 2);
  const slug = slugify(LAST_PRD.userStories && LAST_PRD.userStories[0] ? LAST_PRD.userStories[0].title : LAST_PRD.project);
  try {
    await navigator.clipboard.writeText(json);
    showToast('PRD JSON copied — paste into prd-' + slug + '.json at repo root', 'success');
  } catch (e) {
    showToast('Clipboard blocked — copy from the console (logged)', 'error');
    // eslint-disable-next-line no-console
    console.log(json);
  }
}

async function saveAndSpawn() {
  if (!LAST_IDEA) { setError('Generate a plan first.'); return; }
  setError('');
  const btn = document.getElementById('execute-btn');
  btn.disabled = true; btn.textContent = 'Spawning…';
  try {
    const r = await fetch('/api/plan/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: LAST_IDEA, auto_spawn: true }),
    });
    if (r.status === 503) {
      const j = await r.json().catch(() => ({}));
      setError((j.error || 'AI Breakdown unavailable') + (j.hint ? ' — ' + j.hint : ' — set ANTHROPIC_API_KEY and reboot Swrm.'));
      return;
    }
    if (r.status === 400) {
      const j = await r.json().catch(() => ({}));
      setError(j.error || 'The idea is required.');
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError('Spawn failed: ' + (j.error || r.statusText));
      return;
    }
    const j = await r.json();
    const firstTaskId = j.task_id
      || (Array.isArray(j.task_ids) ? j.task_ids[0] : undefined)
      || (j.attempt && j.attempt.task_id);
    if (firstTaskId != null) {
      window.location.href = '/workspace/' + firstTaskId;
      return;
    }
    showToast('Plan executed, but no task id came back', 'info');
  } catch (e) {
    setError('Network error: ' + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false; btn.textContent = 'Save & spawn first attempt';
  }
}

// Cmd/Ctrl+Enter from the textarea triggers generate.
document.getElementById('idea-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && HAS_API_KEY) generatePlan();
});
</script>
</body></html>`;
}

export async function homeHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _db?: Database.Database,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }
  // db is unused at render time — reference to silence noUnusedParameters
  // without changing the router-facing signature.
  void _db;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderHomeHtml({ hasApiKey }));
  return true;
}
