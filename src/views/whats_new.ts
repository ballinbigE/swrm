// src/views/whats_new.ts — GET /whats-new
//
// A small self-contained HTML page showing the What's New release notes.
// Charcoal/honey palette (#15130F bg, #F5A623 honey, #F3E9D2 cream) matching
// the favicon + native app brand. Uses the same esc()/inline-CSS approach as
// the other views.

import * as http from 'node:http';

import { appVersion, WHATS_NEW } from '../version';

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Very light markdown bold + inline-code pass — only what the notes use. */
function renderNote(raw: string): string {
  return esc(raw)
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // `code`
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

const CSS = `
* { box-sizing: border-box }
body { margin: 0; font: 15px/1.6 -apple-system, system-ui, sans-serif;
       color: #F3E9D2; background: #15130F; min-height: 100vh;
       display: flex; flex-direction: column }
.topbar { display: flex; align-items: center; gap: 14px; padding: 10px 18px;
          background: #1c1912; border-bottom: 1px solid #2e2a20 }
.topbar .brand { color: #F5A623; font-weight: 700; font-size: 15px }
.topbar .spacer { flex: 1 }
.back-link { color: #a89070; text-decoration: none; font-size: 13px;
             padding: 4px 10px; border: 1px solid #3a3020; border-radius: 4px }
.back-link:hover { color: #F3E9D2 }
main { flex: 1; display: flex; align-items: flex-start; justify-content: center;
       padding: 48px 18px }
.card { width: 100%; max-width: 600px }
.version-chip { display: inline-block; background: #F5A623; color: #15130F;
                font-size: 11px; font-weight: 700; padding: 2px 8px;
                border-radius: 10px; letter-spacing: 0.04em; margin-bottom: 14px }
h1 { margin: 0 0 24px 0; font-size: 22px; font-weight: 700; color: #F3E9D2;
     line-height: 1.3 }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px }
li { padding: 14px 16px; background: #1c1912; border-radius: 8px;
     border-left: 3px solid #F5A623; line-height: 1.6; color: #d8cdb8 }
li strong { color: #F3E9D2 }
li code { background: #0f0e0b; padding: 1px 5px; border-radius: 3px;
          color: #FFC24B; font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 13px }
.footer { margin-top: 32px; font-size: 12px; color: #6b6050 }
.footer a { color: #a89070; text-decoration: none }
.footer a:hover { color: #F3E9D2 }
`;

function renderWhatsNewHtml(version: string): string {
  const notesHtml = WHATS_NEW.notes
    .map((n) => `  <li>${renderNote(n)}</li>`)
    .join('\n');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What's New — swrm v${esc(version)}</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <span class="brand">swrm</span>
  <div class="spacer"></div>
  <a class="back-link" href="/">← back</a>
</header>
<main>
  <div class="card">
    <div class="version-chip">v${esc(version)}</div>
    <h1>${esc(WHATS_NEW.title)}</h1>
    <ul>
${notesHtml}
    </ul>
    <p class="footer">See also: <a href="/board">board</a> · <a href="/tasks">tasks</a></p>
  </div>
</main>
</body></html>`;
}

/**
 * Handles GET /whats-new.
 * Returns true if the request was handled (caller should return early).
 */
export function whatsNewHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/whats-new') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return true;
  }
  const version = appVersion();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(renderWhatsNewHtml(version));
  return true;
}
