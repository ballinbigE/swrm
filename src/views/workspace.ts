// scripts/pm/views/workspace.ts — US-VK-003 per-task workspace.
//
// Server-rendered HTML at GET /workspace/:task_id. Three-pane CSS grid:
//   ┌─────────────┬─────────────┬────────────┐
//   │ conversation │ diff        │ preview    │
//   │ chat_messages│ git patch   │ iframe     │
//   └─────────────┴─────────────┴────────────┘
// Top bar: task title + attempts dropdown (switch active attempt).
// Empty states are honest ("no attempts yet" / "no messages yet").

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { type AttemptRow, listAttempts } from '../api/attempts';
import { type CommentRow, listComments } from '../api/attempt_comments';
import { type CommitInfo, commitsBetween } from '../lib/worktree';

interface TaskRow {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  description: string | null;
  board_id: number;
}

interface ChatRow {
  id: number;
  role: string;
  content: string;
  created_at: string;
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

function renderAttemptsDropdown(attempts: AttemptRow[], activeId: number | null): string {
  if (attempts.length === 0) {
    return `<span class="muted">no attempts yet — POST /api/tasks/:id/attempts to spawn one</span>`;
  }
  const opts = attempts
    .map(
      (a) =>
        `<option value="${a.id}"${a.id === activeId ? ' selected' : ''}>#${a.attempt_number} · ${esc(a.agent_name)} · ${esc(a.status)}</option>`,
    )
    .join('');
  return `<select id="attempt-picker" onchange="onPickAttempt(this.value)">${opts}</select>`;
}

function renderChat(messages: ChatRow[]): string {
  if (messages.length === 0) {
    return `<div class="empty">no messages yet · chat_messages table is wired but no writer</div>`;
  }
  return messages
    .map(
      (m) =>
        `<div class="msg msg-${esc(m.role)}">
          <header><span class="role">${esc(m.role)}</span><time>${esc(m.created_at)}</time></header>
          <pre class="content">${esc(m.content)}</pre>
        </div>`,
    )
    .join('');
}

const CSS = `
* { box-sizing: border-box }
body { margin: 0; font: 13px/1.45 -apple-system, system-ui, sans-serif;
       color: #e8e6e3; background: #0c0d10; min-height: 100vh; display: flex; flex-direction: column }
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
          background: #15171c; border-bottom: 1px solid #232730; flex-wrap: nowrap; overflow: hidden }
.topbar .brand { color: #d97757; font-weight: 600; font-size: 13px; white-space: nowrap }
.topbar .slash { color: #4a4f5b; margin: 0 3px }
.topbar .title { color: #8b8f9b; font-weight: 400 }
.topbar h1 { margin: 0; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0 }
.topbar .meta { color: #6b7280; font-size: 11px; white-space: nowrap }
.topbar select { background: #1a1d24; color: #e8e6e3; border: 1px solid #2a2e38;
                 border-radius: 4px; padding: 3px 6px; font: 12px inherit; max-width: 180px }
.topbar .muted { color: #6b7280; font-size: 11px; font-style: italic; white-space: nowrap }
.topbar .spacer { flex: 1; min-width: 8px }
.btn { background: #2a2e38; color: #e8e6e3; border: 1px solid #353a47;
       border-radius: 4px; padding: 4px 9px; font: 12px -apple-system, system-ui, sans-serif;
       cursor: pointer; transition: background .15s; white-space: nowrap }
.btn:hover { background: #353a47 }
.btn.primary { background: #d97757; border-color: #d97757; color: #1a1108 }
.btn.primary:hover { background: #e08866 }
.btn.ghost { background: transparent; border-color: #2a2e38; color: #8b8f9b }
.btn.ghost:hover { background: #1a1d24; color: #e8e6e3 }
.btn:disabled { opacity: 0.4; cursor: not-allowed }
.layout { flex: 1; display: grid; grid-template-columns: 320px 1fr 340px;
          gap: 1px; background: #232730; height: calc(100vh - 56px) }
.pane { background: #0f1115; overflow: auto; padding: 12px 14px; min-width: 0 }
.pane > header { display: flex; justify-content: space-between; align-items: baseline;
                 margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #1f232c }
.pane > header h2 { margin: 0; font-size: 11px; text-transform: uppercase;
                    letter-spacing: 0.08em; color: #8b8f9b; font-weight: 600 }
.pane > header .badge { color: #6b7280; font-size: 11px }
.empty { color: #6b7280; font-size: 12px; padding: 20px 8px; text-align: center; font-style: italic }
.msg { margin-bottom: 12px; padding: 8px 10px; background: #15181f; border-radius: 6px;
       border-left: 3px solid #2a2e38 }
.msg-user { border-left-color: #d97757 }
.msg-assistant { border-left-color: #60a5fa }
.msg-system { border-left-color: #4a4f5b; opacity: 0.7 }
.msg header { display: flex; justify-content: space-between; margin-bottom: 4px }
.msg .role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b8f9b }
.msg time { font-size: 11px; color: #4a4f5b }
.msg .content { margin: 0; font: inherit; white-space: pre-wrap; word-break: break-word }
.diff-body { font: 12px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
             white-space: pre; overflow-x: auto; tab-size: 2; counter-reset: diffline }
.diff-line { display: block; cursor: pointer; padding-left: 28px; position: relative }
.diff-line:hover { background: #1a1d24 }
.diff-line::before { counter-increment: diffline; content: counter(diffline); position: absolute;
                     left: 0; width: 22px; color: #4a4f5b; font-size: 10px; text-align: right;
                     padding-right: 4px; user-select: none }
.diff-body .add { background: #15321e; color: #4ade80 }
.diff-body .del { background: #391a1a; color: #fca5a5 }
.diff-body .hunk { color: #8b8f9b; background: #1a1d24 }
.diff-body .file { color: #f6c545; font-weight: 600; margin-top: 12px; cursor: default }
.diff-line.has-comment { box-shadow: inset 3px 0 0 0 #fbbf24 }
.composer { display: none; padding: 10px; background: #1a1d24; border-left: 3px solid #fbbf24;
            margin: 4px 0 8px 28px }
.composer textarea { width: 100%; min-height: 60px; background: #0f1115; color: #e8e6e3;
                     border: 1px solid #2a2e38; border-radius: 4px; padding: 6px 8px;
                     font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; resize: vertical }
.composer .actions { display: flex; gap: 8px; margin-top: 6px; justify-content: flex-end }
.preview-img { width: 100%; height: auto; display: block; border-radius: 4px;
               background: #1a1d24; min-height: 200px }
.preview-meta { color: #4a4f5b; font-size: 10px; margin-top: 6px; text-align: center; font-family: ui-monospace, monospace }
.task-desc { color: #b8bcc8; font-size: 12px; line-height: 1.5; margin-bottom: 10px }
.status-pill { display: inline-block; padding: 2px 7px; border-radius: 3px; font-size: 11px;
               background: #2a2e38; color: #c8ccd6; text-transform: uppercase; letter-spacing: 0.05em }
.status-backlog { background: #2a2e38 }
.status-todo { background: #1e3a5a; color: #93c5fd }
.status-in_progress { background: #5a3a1e; color: #fbbf24 }
.status-review { background: #4a1e5a; color: #c084fc }
.status-done { background: #1e5a3a; color: #4ade80 }
.attempt-info { font-size: 11px; color: #6b7280; padding: 8px 10px; background: #15181f;
                border-radius: 4px; margin-bottom: 10px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap }
.attempt-info code { color: #d97757 }
.attempt-info .stat { color: #8b8f9b }
.comments-rail { margin-top: 14px; padding-top: 10px; border-top: 1px solid #1f232c }
.comment-card { padding: 8px 10px; background: #15181f; border-radius: 6px; margin-bottom: 8px;
                border-left: 3px solid #fbbf24 }
.comment-card.resolved { opacity: 0.5; border-left-color: #4a4f5b }
.comment-card header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px }
.comment-card .loc { font-size: 10px; color: #8b8f9b; font-family: ui-monospace, monospace }
.comment-card .body { font-size: 12px; color: #e8e6e3 }
.comment-card .actions { margin-top: 4px; display: flex; gap: 6px }
.comment-card .actions button { background: transparent; border: 0; color: #4a4f5b;
                                font-size: 10px; cursor: pointer; padding: 0 }
.comment-card .actions button:hover { color: #8b8f9b }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none;
         align-items: center; justify-content: center; z-index: 100 }
.modal.open { display: flex }
.modal-card { background: #15171c; border: 1px solid #232730; border-radius: 8px;
              padding: 16px; max-width: 600px; width: 90%; max-height: 80vh; overflow: auto }
.modal-card h3 { margin: 0 0 10px 0; font-size: 14px; color: #d97757 }
.modal-card pre { background: #0c0d10; padding: 10px; border-radius: 4px; max-height: 400px;
                  overflow: auto; font: 11px/1.4 ui-monospace, monospace; color: #e8e6e3; white-space: pre-wrap }
.modal-card .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px }
/* status dot + pulse for running attempts */
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
              background: #4a4f5b; vertical-align: middle }
.status-dot.status-running { background: #4ade80 }
.status-dot.status-completed { background: #60a5fa }
.status-dot.status-failed { background: #fca5a5 }
.status-dot.status-abandoned { background: #6b7280 }
.status-dot.pulse { animation: pulse 1.6s ease-in-out infinite }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6) }
  50%      { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0) }
}

/* icon-style compact buttons in the attempt-info bar */
.btn.icon { padding: 3px 8px; min-width: 28px; font-size: 14px; line-height: 1 }
.btn.icon.danger { color: #fca5a5; border-color: #5a2e2e }
.btn.icon.danger:hover { background: #2a1414; color: #fca5a5 }
.attempt-info .spacer { flex: 1 }
.attempt-info .attempt-num { font-weight: 600; color: #d97757 }
.attempt-info .branch { color: #d97757 }
.attempt-info .sha-line { display: inline-flex; align-items: center; gap: 4px }
.attempt-info .sha-line .arrow { color: #4a4f5b }
.attempt-info .stat code { color: #c8ccd6 }

/* commit-log subsection inside the diff pane */
.commit-log { background: #15181f; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px }
.commit-log header h3 { margin: 0 0 6px 0; font-size: 11px;
                        text-transform: uppercase; letter-spacing: 0.06em;
                        color: #8b8f9b; font-weight: 600 }
.commit-row { display: grid; grid-template-columns: 60px 1fr auto;
              gap: 10px; padding: 4px 0; align-items: baseline;
              border-bottom: 1px solid #1f232c; font-size: 12px }
.commit-row:last-child { border-bottom: 0 }
.commit-row .sha { color: #d97757; font-size: 11px }
.commit-row .subject { color: #e8e6e3; overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap }
.commit-row time { color: #4a4f5b; font-size: 11px }

/* quickstart card when worktree is empty */
.quickstart { background: #15181f; border-radius: 8px; padding: 16px 18px;
              border-left: 3px solid #d97757; margin-top: 6px }
.quickstart .qs-header { color: #e8e6e3; font-size: 13px; font-weight: 500; margin-bottom: 10px }
.quickstart ol { margin: 0; padding-left: 22px; color: #c8ccd6; font-size: 12px; line-height: 1.8 }
.quickstart ol li code { background: #0c0d10; padding: 1px 5px; border-radius: 3px;
                         color: #d97757; font-size: 11px }
.quickstart .kbd-inline { display: inline-block; padding: 0 6px; background: #2a2e38;
                          border-radius: 3px; font-family: ui-monospace, monospace; font-size: 11px }
.quickstart .qs-worktree { margin-top: 12px; padding-top: 10px; border-top: 1px solid #1f232c;
                           font-size: 11px; color: #6b7280 }
.quickstart .qs-worktree code { color: #d97757; user-select: all }
kbd { display: inline-block; padding: 1px 6px; background: #2a2e38; border: 1px solid #353a47;
      border-radius: 3px; font-family: ui-monospace, monospace; font-size: 11px; color: #e8e6e3 }

/* sim preview pane: fill the whole right column */
.pane.preview-pane { display: flex; flex-direction: column }
.preview-img { width: 100%; height: auto; max-height: calc(100vh - 130px);
               object-fit: contain; flex: 1; min-height: 0 }

/* Convo | Logs tab switcher */
.tab-switcher { display: flex; gap: 0; width: 100% }
.tab-switcher .tab { background: transparent; color: #6b7280; border: 0;
                     padding: 6px 12px; font: 11px -apple-system, system-ui, sans-serif;
                     text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
                     cursor: pointer; border-bottom: 2px solid transparent }
.tab-switcher .tab:hover { color: #c8ccd6 }
.tab-switcher .tab.active { color: #d97757; border-bottom-color: #d97757 }
.tab-switcher .tab-count { background: #2a2e38; color: #c8ccd6; padding: 0 6px;
                           border-radius: 8px; font-size: 10px; margin-left: 4px }
.tab-body { padding-top: 8px }
.terminal { background: #0a0b0e; border: 1px solid #1f232c; border-radius: 4px;
            padding: 8px; max-height: calc(100vh - 180px); overflow-y: auto }
.log-stream { font: 11px/1.4 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace }
.log-line { display: grid; grid-template-columns: 60px 1fr; gap: 8px; padding: 1px 0;
            white-space: pre-wrap; word-break: break-word }
.log-line time { color: #4a4f5b; font-size: 10px }
.log-line.log-assistant .log-content { color: #4ade80 }
.log-line.log-system .log-content { color: #fbbf24 }

#toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 14px;
         border-radius: 6px; font-size: 12px; z-index: 200; max-width: 360px;
         box-shadow: 0 6px 20px rgba(0,0,0,0.4); transition: opacity .2s; }
#toast[hidden] { opacity: 0; pointer-events: none }
.toast-error { background: #391a1a; color: #fca5a5; border: 1px solid #5a2e2e }
.toast-info { background: #1e3a5a; color: #93c5fd; border: 1px solid #2a4a6a }
.toast-success { background: #15321e; color: #4ade80; border: 1px solid #1e5a3a }
`;

function colorizeDiff(patch: string, commentLineNumbers: Set<number>): string {
  if (patch.length === 0) {
    return '<div class="empty">no changes yet · attempt is unchanged from base</div>';
  }
  let currentFile = '';
  return patch
    .split('\n')
    .map((line, idx) => {
      const lineNo = idx + 1;
      const escaped = esc(line);
      const hasComment = commentLineNumbers.has(lineNo) ? ' has-comment' : '';

      if (line.startsWith('diff --git')) {
        // Extract the 'b/path' side which is the new file path
        const match = line.match(/ b\/(.+)$/);
        currentFile = match ? match[1] : '';
        return `<span class="diff-line file" data-file="${esc(currentFile)}" data-line-no="${lineNo}">${escaped}</span>`;
      }
      const cls = line.startsWith('@@')
        ? 'hunk'
        : line.startsWith('+') && !line.startsWith('+++')
          ? 'add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'del'
            : '';
      const rawLine = line.replace(/^[+-]/, '');
      return `<span class="diff-line ${cls}${hasComment}" data-file="${esc(currentFile)}" data-line-no="${lineNo}" data-diff-line="${esc(rawLine.slice(0, 200))}">${escaped}</span>`;
    })
    .join('');
}

/**
 * Compose the default spawn prompt from the task + any open comments.
 * Pure, testable. Returns '' when task has only a title (avoids
 * stuffing the textarea with low-value boilerplate).
 */
export function buildSpawnPromptDefault(
  task: { title: string; description: string | null },
  openComments: { file_path: string | null; line_number: number | null; body: string }[] = [],
): string {
  const parts: string[] = [];
  const desc = (task.description ?? '').trim();
  if (desc.length > 0) parts.push(`Task: ${task.title}\n\n${desc}`);

  if (openComments.length > 0) {
    parts.push('Open feedback:');
    for (const c of openComments) {
      const where = c.file_path
        ? `${c.file_path}${c.line_number ? `:${c.line_number}` : ''}`
        : 'file-level';
      parts.push(`- ${where} — ${c.body.trim()}`);
    }
  }

  return parts.join('\n\n');
}

function fmtRelativeTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderDiffPane(
  diff: { patch: string; baseSha: string; headSha: string } | null,
  commits: CommitInfo[],
  commentLineSet: Set<number>,
  activeAttempt: AttemptRow | null,
): string {
  if (!activeAttempt) {
    return `<div class="empty">
      <div style="font-size: 13px; margin-bottom: 10px">No attempt active.</div>
      <div style="font-size: 12px; color: #4a4f5b">Press <kbd>s</kbd> or click <b>+ Attempt</b> to spawn one.</div>
    </div>`;
  }

  const hasDiff = diff && diff.patch.length > 0;
  const hasCommits = commits.length > 0;

  // Commit log section (always shown when commits exist; useful supplement)
  const commitLog = hasCommits
    ? `<div class="commit-log">
        <header><h3>Commits in this attempt (${commits.length})</h3></header>
        ${commits.map((c) => `
          <div class="commit-row">
            <code class="sha">${esc(c.sha.slice(0, 7))}</code>
            <span class="subject">${esc(c.subject)}</span>
            <time>${esc(fmtRelativeTime(c.isoDate))}</time>
          </div>`).join('')}
      </div>`
    : '';

  if (hasDiff) {
    return commitLog + `<div class="diff-body" id="diff-body" data-attempt-id="${activeAttempt.id}">${colorizeDiff(diff.patch, commentLineSet)}</div>`;
  }

  // No file diff, but maybe commits exist (touched nothing, or only deletions in unusual way)
  if (hasCommits) {
    return commitLog + `<div class="empty"><span style="font-size: 12px; color: #6b7280">no file diff between base and head — see commit list above</span></div>`;
  }

  // Genuinely empty — render a quickstart card
  return `<div class="quickstart">
    <div class="qs-header">Worktree is empty. Get started.</div>
    <ol>
      <li>Open the worktree: click <span class="kbd-inline">⌗</span> (VSCode) or press <kbd>e</kbd></li>
      <li>Edit + <code>git add . &amp;&amp; git commit</code> inside the worktree</li>
      <li>Diff appears here within 5s (auto-poll)</li>
      <li>Click any diff line to comment, press <kbd>r</kbd> to bundle into a reprompt</li>
      <li>Press <kbd>m</kbd> to merge into <code>main</code> when satisfied</li>
    </ol>
    <div class="qs-worktree">
      <span>worktree:</span> <code>${esc(activeAttempt.worktree_path)}</code>
    </div>
  </div>`;
}

function renderLogs(messages: ChatRow[]): string {
  if (messages.length === 0) {
    return '<div class="empty">no agent output yet · spawn an attempt with auto-run to stream logs here</div>';
  }
  return `<div class="log-stream" id="log-stream">${messages.map((m) => renderLogLine(m)).join('')}</div>`;
}

function renderLogLine(m: ChatRow): string {
  const cls = m.role === 'system' ? 'log-line log-system' : 'log-line log-assistant';
  return `<div class="${cls}"><time>${esc(m.created_at.slice(-8))}</time><span class="log-content">${esc(m.content)}</span></div>`;
}

function renderCommentsRail(comments: CommentRow[]): string {
  if (comments.length === 0) {
    return `<div class="comments-rail"><div class="empty">no comments yet · click a diff line to add one</div></div>`;
  }
  const items = comments
    .map((c) => {
      const loc = c.file_path ? `${esc(c.file_path)}${c.line_number ? `:${c.line_number}` : ''}` : 'file-level';
      const resolved = c.resolved ? ' resolved' : '';
      return `<div class="comment-card${resolved}" data-comment-id="${c.id}">
        <header><span class="loc">${loc}</span><time style="font-size: 10px; color: #4a4f5b">${esc(c.created_at)}</time></header>
        <div class="body">${esc(c.body)}</div>
        <div class="actions">
          ${c.resolved
            ? `<button onclick="toggleResolved(${c.id}, false)">reopen</button>`
            : `<button onclick="toggleResolved(${c.id}, true)">resolve</button>`}
          <button onclick="deleteComment(${c.id})">delete</button>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="comments-rail">
    <header style="display: flex; justify-content: space-between; margin-bottom: 8px">
      <h2 style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b8f9b; margin: 0">Comments</h2>
      <span style="color: #6b7280; font-size: 11px">${comments.filter((c) => !c.resolved).length} open · ${comments.length} total</span>
    </header>
    ${items}
  </div>`;
}

export interface WorkspacePayload {
  task: TaskRow;
  attempts: AttemptRow[];
  activeAttempt: AttemptRow | null;
  chat: ChatRow[];
  comments: CommentRow[];
  diff: { patch: string; baseSha: string; headSha: string } | null;
  commits: CommitInfo[];
}

export function renderWorkspaceHtml(payload: WorkspacePayload): string {
  const { task, attempts, activeAttempt, chat, comments, diff, commits } = payload;

  const commentLineSet = new Set(
    comments.filter((c) => c.line_number !== null).map((c) => c.line_number as number),
  );

  const attemptInfo = activeAttempt
    ? `<div class="attempt-info">
        <span class="attempt-num">#${activeAttempt.attempt_number}</span>
        <code class="branch">${esc(activeAttempt.branch_name)}</code>
        <span class="stat sha-line"><code>${esc((activeAttempt.base_sha ?? '').slice(0, 7))}</code><span class="arrow">→</span><code>${esc((activeAttempt.head_sha ?? '').slice(0, 7))}</code></span>
        <span class="status-dot status-${esc(activeAttempt.status)}${activeAttempt.status === 'running' ? ' pulse' : ''}" title="${esc(activeAttempt.status)}"></span>
        <span class="spacer"></span>
        <a class="btn icon" href="vscode://file${encodeURI(activeAttempt.worktree_path)}" title="Open worktree in VSCode">⌗</a>
        <button class="btn icon" onclick="copyCdCmd('${esc(activeAttempt.worktree_path)}')" title="Copy 'cd <path>' to clipboard">⎘</button>
        <button class="btn icon" onclick="copyWorktree('${esc(activeAttempt.worktree_path)}')" title="Copy worktree path">⧉</button>
        <button class="btn icon danger" onclick="discardAttempt(${activeAttempt.id})" title="Discard attempt + delete worktree">✕</button>
      </div>`
    : '';

  const diffPane = renderDiffPane(diff, commits, commentLineSet, activeAttempt);

  const taskId = task.id;
  const spawnBtn = `<button class="btn primary" onclick="openSpawnModal(${taskId})" title="Spawn new attempt with optional auto-run">+ Attempt</button>`;
  const openCommentCount = comments.filter((c) => !c.resolved).length;
  const repromptBtn = activeAttempt
    ? `<button class="btn" onclick="reprompt(${activeAttempt.id})" ${openCommentCount === 0 ? 'disabled title="no open comments"' : `title="Bundle ${openCommentCount} open comments into one prompt"`}>↺ Reprompt${openCommentCount > 0 ? ` (${openCommentCount})` : ''}</button>`
    : '';
  const mergeBtn = activeAttempt
    ? `<button class="btn" onclick="mergeAttempt(${activeAttempt.id})" ${activeAttempt.status !== 'running' && activeAttempt.status !== 'completed' ? 'disabled title="cannot merge a failed/abandoned attempt"' : 'title="git merge --no-ff this attempt into main, mark completed, clean up worktree"'}>✓ Merge</button>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<title>workspace · ${esc(task.title)}</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <a class="brand" href="/" style="text-decoration: none" title="Board">Loom</a>
  <span class="slash">/</span>
  <a href="/tasks" class="title" style="text-decoration: none" title="Tasks list">workspace</a>
  <span class="slash">/</span>
  <h1 title="#${task.id} ${esc(task.title)}">#${task.id} ${esc(task.title)}</h1>
  <span class="status-pill status-${esc(task.status)}">${esc(task.status)}</span>
  <div class="spacer"></div>
  ${renderAttemptsDropdown(attempts, activeAttempt?.id ?? null)}
  ${spawnBtn}
  ${repromptBtn}
  ${mergeBtn}
  <button class="btn ghost" onclick="openHelp()" title="Keyboard shortcuts (?)">?</button>
</header>
<main class="layout">
  <section class="pane">
    <header>
      <div class="tab-switcher">
        <button class="tab active" data-tab="convo" onclick="switchTab('convo')">Convo <span class="tab-count">${chat.length}</span></button>
        <button class="tab" data-tab="logs" onclick="switchTab('logs')">Logs <span class="tab-count" id="log-count">${chat.filter((m) => m.role === 'assistant' || m.role === 'system').length}</span></button>
      </div>
    </header>
    <div id="tab-convo" class="tab-body">
      ${task.description ? `<div class="task-desc">${esc(task.description)}</div>` : ''}
      ${renderChat(chat)}
      ${renderCommentsRail(comments)}
    </div>
    <div id="tab-logs" class="tab-body terminal" hidden>
      ${renderLogs(chat.filter((m) => (m.role === 'assistant' || m.role === 'system')))}
    </div>
  </section>
  <section class="pane">
    <header>
      <h2>Diff</h2>
      <span class="badge">${diff && diff.patch.length > 0 ? `${diff.patch.split('\n').length} lines · ${comments.filter((c) => !c.resolved).length} open comments` : '0'}</span>
    </header>
    ${attemptInfo}
    ${diffPane}
  </section>
  <section class="pane preview-pane">
    <header>
      <h2>Preview</h2>
      <span class="badge"><a href="#" onclick="refreshPreview();return false" style="color: #8b8f9b; text-decoration: none">⟳ refresh</a></span>
    </header>
    <img class="preview-img" id="preview-img" src="/api/sim/screenshot.png?t=${Date.now()}" alt="iOS sim screenshot" />
    <div class="preview-meta" id="preview-meta">auto-refresh every 3s · live xcrun simctl io booted screenshot</div>
  </section>
</main>

<!-- composer template (cloned on diff-line click) -->
<template id="composer-tpl">
  <div class="composer">
    <textarea placeholder="comment on this line · cmd+enter to submit"></textarea>
    <div class="actions">
      <button class="btn ghost" data-action="cancel">cancel</button>
      <button class="btn primary" data-action="submit">comment</button>
    </div>
  </div>
</template>

<!-- toast notification slot -->
<div id="toast" hidden></div>

<!-- help / shortcuts overlay -->
<div class="modal" id="help-modal">
  <div class="modal-card">
    <h3>Keyboard shortcuts</h3>
    <pre>j / k        next / prev diff line
c            comment on focused line
r            reprompt (bundle open comments)
s            spawn new attempt
m            merge active attempt
e            open active worktree in VSCode
g t          go to /tasks
g b          go to / (board)
?            show this overlay
Esc          close any modal / composer
cmd+enter    submit composer</pre>
    <div class="actions">
      <button class="btn primary" onclick="closeHelp()">close</button>
    </div>
  </div>
</div>

<!-- spawn modal -->
<div class="modal" id="spawn-modal">
  <div class="modal-card">
    <h3>Spawn attempt</h3>
    <label style="display:block; margin-bottom:8px; color:#8b8f9b; font-size:11px">repo
      <input id="spawn-repo-root" list="spawn-repo-list" placeholder="${esc(process.cwd())}"
        style="width:100%; margin-top:4px; background:#0f1115; color:#e8e6e3;
               border:1px solid #2a2e38; border-radius:4px; padding:4px 6px;
               font:12px ui-monospace, SFMono-Regular, monospace" />
      <datalist id="spawn-repo-list">
        ${Array.from(new Set(attempts.map((a) => a.repo_root).filter((r) => r && r.length > 0)))
          .map((r) => `<option value="${esc(r)}"></option>`)
          .join('')}
      </datalist>
    </label>
    <label style="display:block; margin-bottom:8px; color:#8b8f9b; font-size:11px">agent
      <select id="spawn-agent" style="width:100%; margin-top:4px">
        <option value="claude-code">claude-code</option>
        <option value="codex">codex</option>
        <option value="gemini">gemini</option>
        <option value="manual">manual (no auto-run)</option>
      </select>
    </label>
    <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px; color:#e8e6e3">
      <input type="checkbox" id="spawn-auto-run" />
      <span>auto-run agent in worktree on spawn</span>
    </label>
    <label style="display:block; color:#8b8f9b; font-size:11px">prompt (used when auto-run)
      <textarea id="spawn-prompt" rows="6" placeholder="implement the task per its acceptance criteria"
        style="width:100%; margin-top:4px; background:#0f1115; color:#e8e6e3;
               border:1px solid #2a2e38; border-radius:4px; padding:6px;
               font:12px/1.45 ui-monospace, SFMono-Regular, monospace; resize:vertical">${esc(buildSpawnPromptDefault(task, comments.filter((c) => !c.resolved)))}</textarea>
    </label>
    <div class="actions">
      <button class="btn ghost" onclick="closeSpawnModal()">cancel</button>
      <button class="btn primary" onclick="submitSpawn()">spawn</button>
    </div>
  </div>
</div>

<!-- reprompt modal -->
<div class="modal" id="reprompt-modal">
  <div class="modal-card">
    <h3>Re-prompt for Claude Code</h3>
    <pre id="reprompt-body">loading…</pre>
    <div class="actions">
      <button class="btn ghost" onclick="closeReprompt()">close</button>
      <button class="btn primary" onclick="copyReprompt()">copy to clipboard</button>
    </div>
  </div>
</div>

<script>
const ATTEMPT_ID = ${activeAttempt?.id ?? 'null'};
const ATTEMPT_STATUS = ${JSON.stringify(activeAttempt?.status ?? null)};
const CURRENT_HEAD = ${JSON.stringify(activeAttempt?.head_sha ?? null)};
const TASK_ID = ${taskId};

// ── toast notifications ──────────────────────────────────────────
let toastTimer = null;
function showToast(msg, level) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast-' + (level || 'info');
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function onPickAttempt(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('attempt', id);
  window.location.href = url.toString();
}

function openSpawnModal(taskId) {
  document.getElementById('spawn-modal').dataset.taskId = String(taskId);
  document.getElementById('spawn-modal').classList.add('open');
}
function closeSpawnModal() { document.getElementById('spawn-modal').classList.remove('open'); }
async function submitSpawn() {
  const taskId = Number(document.getElementById('spawn-modal').dataset.taskId);
  const agent = document.getElementById('spawn-agent').value;
  const autoRun = document.getElementById('spawn-auto-run').checked;
  const prompt = document.getElementById('spawn-prompt').value;
  const repoRoot = document.getElementById('spawn-repo-root').value.trim();
  const body = { agent_name: agent, auto_run: autoRun, prompt };
  if (repoRoot.length > 0) body.repo_root = repoRoot;
  const r = await fetch('/api/tasks/' + taskId + '/attempts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showToast('spawn failed: ' + (await r.text()), 'error'); return; }
  const j = await r.json();
  closeSpawnModal();
  const url = new URL(window.location.href);
  url.searchParams.set('attempt', j.attempt.id);
  window.location.href = url.toString();
}

// Legacy entry point kept for any out-of-band callers
async function spawnAttempt(taskId) { openSpawnModal(taskId); }

async function reprompt(attemptId) {
  const r = await fetch('/api/attempts/' + attemptId + '/reprompt', { method: 'POST' });
  if (!r.ok) { showToast('reprompt failed: ' + (await r.text()), 'error'); return; }
  const j = await r.json();
  document.getElementById('reprompt-body').textContent = j.prompt || '(no open comments)';
  document.getElementById('reprompt-modal').classList.add('open');
}
function closeReprompt() { document.getElementById('reprompt-modal').classList.remove('open'); }
async function copyReprompt() {
  const text = document.getElementById('reprompt-body').textContent;
  await navigator.clipboard.writeText(text);
  showToast('copied to clipboard', 'success');
  closeReprompt();
}

async function copyWorktree(path) {
  await navigator.clipboard.writeText(path);
  showToast('worktree path copied', 'success');
}
async function copyCdCmd(path) {
  await navigator.clipboard.writeText('cd ' + path);
  showToast('cd command copied', 'success');
}

async function mergeAttempt(id) {
  if (!confirm('Merge attempt #' + id + ' into main? This runs git merge --no-ff and cleans up the worktree.')) return;
  const r = await fetch('/api/attempts/' + id + '/merge', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) { showToast('merge failed: ' + (await r.text()), 'error'); return; }
  const j = await r.json();
  if (!j.ok) { showToast('merge refused: ' + j.reason, 'error'); return; }
  showToast('merged ' + j.mergedSha.slice(0, 7) + ' into main', 'success');
  setTimeout(() => window.location.reload(), 800);
}

async function discardAttempt(id) {
  if (!confirm('Discard attempt #' + id + '? Removes the worktree + branch + DB row. Comments are preserved.')) return;
  const r = await fetch('/api/attempts/' + id, { method: 'DELETE' });
  if (!r.ok) { showToast('discard failed: ' + (await r.text()), 'error'); return; }
  showToast('attempt #' + id + ' discarded', 'info');
  setTimeout(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('attempt');
    window.location.href = url.toString();
  }, 600);
}

function openHelp() { document.getElementById('help-modal').classList.add('open'); }
function closeHelp() { document.getElementById('help-modal').classList.remove('open'); }

function refreshPreview() {
  const img = document.getElementById('preview-img');
  if (img) img.src = '/api/sim/screenshot.png?t=' + Date.now();
}
setInterval(refreshPreview, 3000);

// ── diff auto-refresh (poll while attempt is running) ─────────────
let diffPollTimer = null;
async function pollDiff() {
  if (!ATTEMPT_ID) return;
  try {
    const r = await fetch('/api/attempts/' + ATTEMPT_ID, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_diff: true }),
    });
    if (!r.ok) return;
    const j = await r.json();
    if (j.attempt.status !== 'running') {
      stopDiffPoll();
      showToast('attempt ' + j.attempt.status, j.attempt.status === 'completed' ? 'success' : 'info');
      window.location.reload();
      return;
    }
    if (j.attempt.head_sha && j.attempt.head_sha !== CURRENT_HEAD) {
      window.location.reload();
    }
  } catch (e) { /* silent retry on next tick */ }
}
function startDiffPoll() {
  if (!ATTEMPT_ID || ATTEMPT_STATUS !== 'running' || diffPollTimer) return;
  diffPollTimer = setInterval(pollDiff, 5000);
}
function stopDiffPoll() {
  if (diffPollTimer) { clearInterval(diffPollTimer); diffPollTimer = null; }
}
window.addEventListener('beforeunload', stopDiffPoll);
startDiffPoll();

// ── SSE live updates (replaces most full-page reloads) ────────────
let sse = null;
function openStream() {
  if (typeof EventSource === 'undefined' || !TASK_ID) return;
  try {
    sse = new EventSource('/api/workspace/' + TASK_ID + '/stream');
    sse.addEventListener('comment-added', () => { showToast('comment added', 'success'); setTimeout(() => window.location.reload(), 400); });
    sse.addEventListener('comment-updated', () => { setTimeout(() => window.location.reload(), 200); });
    sse.addEventListener('comment-deleted', () => { setTimeout(() => window.location.reload(), 200); });
    sse.addEventListener('attempt-created', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.attempt && d.attempt.task_id === TASK_ID) {
          showToast('attempt #' + d.attempt.attempt_number + ' spawned', 'info');
        }
      } catch {}
    });
    sse.addEventListener('attempt-updated', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.attempt && ATTEMPT_ID && d.attempt.id === ATTEMPT_ID
            && d.attempt.status !== ATTEMPT_STATUS) {
          showToast('attempt ' + d.attempt.status, d.attempt.status === 'completed' ? 'success' : 'info');
          setTimeout(() => window.location.reload(), 600);
        }
      } catch {}
    });
    sse.onerror = () => { /* EventSource auto-reconnects */ };
  } catch { sse = null; }
}
function closeStream() { if (sse) { sse.close(); sse = null; } }
window.addEventListener('beforeunload', closeStream);
openStream();

// ── Convo | Logs tab + live log append ─────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-switcher .tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === name);
  });
  document.getElementById('tab-convo').hidden = (name !== 'convo');
  document.getElementById('tab-logs').hidden = (name !== 'logs');
  if (name === 'logs') {
    const s = document.getElementById('log-stream');
    if (s) s.scrollTop = s.scrollHeight;
  }
}

function appendLogLine(msg) {
  if (!ATTEMPT_ID || msg.attempt_id !== ATTEMPT_ID) return;
  if (msg.message.role !== 'assistant' && msg.message.role !== 'system') return;
  let stream = document.getElementById('log-stream');
  if (!stream) {
    const tab = document.getElementById('tab-logs');
    if (tab) {
      // Replace any prior empty-state child with a fresh log-stream container.
      while (tab.firstChild) tab.removeChild(tab.firstChild);
      stream = document.createElement('div');
      stream.className = 'log-stream';
      stream.id = 'log-stream';
      tab.appendChild(stream);
    }
  }
  if (!stream) return;
  const wrap = document.createElement('div');
  wrap.className = 'log-line log-' + msg.message.role;
  const t = document.createElement('time');
  t.textContent = (msg.message.created_at || '').slice(-8);
  const c = document.createElement('span');
  c.className = 'log-content';
  c.textContent = msg.message.content;
  wrap.appendChild(t); wrap.appendChild(c);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;
  // Bump count badge
  const counter = document.getElementById('log-count');
  if (counter) counter.textContent = String(Number(counter.textContent || '0') + 1);
}

if (sse) {
  sse.addEventListener('chat-message-appended', (ev) => {
    try { appendLogLine(JSON.parse(ev.data)); } catch {}
  });
}

// ── keyboard shortcuts ──────────────────────────────────────────────
let focusedLineIdx = -1;
let gPrefixActive = false;
function focusDiffLine(idx) {
  const lines = Array.from(document.querySelectorAll('.diff-line:not(.file)'));
  if (lines.length === 0) return;
  focusedLineIdx = Math.max(0, Math.min(idx, lines.length - 1));
  lines.forEach((el, i) => {
    el.style.outline = i === focusedLineIdx ? '2px solid #d97757' : 'none';
    if (i === focusedLineIdx) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.open').forEach((el) => el.classList.remove('open'));
    document.querySelectorAll('.composer').forEach((el) => el.remove());
    return;
  }
  if (gPrefixActive) {
    gPrefixActive = false;
    if (e.key === 't') { window.location.href = '/tasks'; return; }
    if (e.key === 'b') { window.location.href = '/'; return; }
    return;
  }
  if (e.key === 'g') { gPrefixActive = true; setTimeout(() => { gPrefixActive = false; }, 1500); return; }
  if (e.key === '?') { openHelp(); return; }
  if (e.key === 'j') { focusDiffLine(focusedLineIdx + 1); return; }
  if (e.key === 'k') { focusDiffLine(focusedLineIdx - 1); return; }
  if (e.key === 'c') {
    const lines = Array.from(document.querySelectorAll('.diff-line:not(.file)'));
    if (lines[focusedLineIdx]) lines[focusedLineIdx].click();
    return;
  }
  if (e.key === 's') { openSpawnModal(TASK_ID); return; }
  if (e.key === 'r' && ATTEMPT_ID) { reprompt(ATTEMPT_ID); return; }
  if (e.key === 'm' && ATTEMPT_ID) { mergeAttempt(ATTEMPT_ID); return; }
  if (e.key === 'e' && ATTEMPT_ID) {
    const wt = document.querySelector('.attempt-info code');
    // Trigger the VSCode link
    const link = document.querySelector('a[href^="vscode://"]');
    if (link) link.click();
    return;
  }
});

// click-to-comment on diff lines
document.addEventListener('click', (ev) => {
  const line = ev.target.closest('.diff-line');
  if (!line || line.classList.contains('file')) return;
  // Hunk header click is allowed but we still mount the composer; the
  // file_path is captured from data-file on the line itself.
  if (!ATTEMPT_ID) { showToast('spawn an attempt first', 'info'); return; }

  // Remove any existing open composer.
  document.querySelectorAll('.composer').forEach((el) => el.remove());

  const tpl = document.getElementById('composer-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.style.display = 'block';
  line.insertAdjacentElement('afterend', node);

  const filePath = line.dataset.file || null;
  const lineNo = Number(line.dataset.lineNo);
  const diffLine = line.dataset.diffLine || null;
  const ta = node.querySelector('textarea');
  ta.focus();

  node.querySelector('[data-action=cancel]').onclick = () => node.remove();
  node.querySelector('[data-action=submit]').onclick = () => submitComment(filePath, lineNo, diffLine, ta.value, node);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      submitComment(filePath, lineNo, diffLine, ta.value, node);
    }
    if (e.key === 'Escape') node.remove();
  });
});

async function submitComment(filePath, lineNumber, diffLine, body, composerNode) {
  body = (body || '').trim();
  if (!body) { showToast('comment body required', 'error'); return; }
  const r = await fetch('/api/attempts/' + ATTEMPT_ID + '/comments', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: filePath, line_number: lineNumber, diff_line: diffLine, body }) });
  if (!r.ok) { showToast('comment failed: ' + (await r.text()), 'error'); return; }
  composerNode.remove();
  window.location.reload();
}

async function toggleResolved(id, resolved) {
  await fetch('/api/comments/' + id, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolved }) });
  window.location.reload();
}
async function deleteComment(id) {
  if (!confirm('delete this comment?')) return;
  await fetch('/api/comments/' + id, { method: 'DELETE' });
  window.location.reload();
}
</script>
</body></html>`;
}

export function loadWorkspacePayload(
  db: Database.Database,
  taskId: number,
  activeAttemptId: number | null,
): WorkspacePayload | null {
  const task = db
    .prepare(`SELECT id, title, status, priority, description, board_id FROM tasks WHERE id = ?`)
    .get(taskId) as TaskRow | undefined;
  if (!task) return null;

  const attempts = listAttempts(db, taskId);
  const active = activeAttemptId
    ? attempts.find((a) => a.id === activeAttemptId) ?? null
    : attempts[attempts.length - 1] ?? null;

  // Only show messages scoped to this task (or to one of its agent_runs).
  // Legacy/global chat_messages (task_id IS NULL) are excluded — they
  // belong to an older era pre-VK-007.
  const chat = active
    ? (db
        .prepare(
          `SELECT id, role, content, created_at FROM chat_messages
           WHERE task_id = ?
              OR agent_run_id IN (SELECT id FROM agent_runs WHERE task_id = ?)
           ORDER BY created_at ASC LIMIT 200`,
        )
        .all(taskId, taskId) as ChatRow[])
    : [];

  const comments = active ? listComments(db, active.id) : [];

  return { task, attempts, activeAttempt: active, chat, comments, diff: null, commits: [] };
}

const WORKSPACE_RE = /^\/workspace\/(\d+)\/?$/;

export async function workspaceHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const m = url.pathname.match(WORKSPACE_RE);
  if (!m) return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }

  const taskId = Number(m[1]);
  const attemptParam = url.searchParams.get('attempt');
  const activeAttemptId = attemptParam ? Number(attemptParam) : null;

  try {
    const payload = loadWorkspacePayload(db, taskId, activeAttemptId);
    if (!payload) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`task ${taskId} not found`);
      return true;
    }

    if (payload.activeAttempt) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { fetchAttemptDiff } = require('../api/diff');
        payload.diff = await fetchAttemptDiff(db, payload.activeAttempt.id);
      } catch {
        payload.diff = { patch: '', baseSha: '', headSha: '' };
      }
      try {
        const a = payload.activeAttempt;
        if (a.base_sha && a.head_sha && a.base_sha !== a.head_sha) {
          // Use stored repo_root or fallback. Prefer worktree HEAD ref via branch name.
          const repoRoot = a.repo_root && a.repo_root.length > 0 ? a.repo_root : process.cwd();
          payload.commits = await commitsBetween(a.base_sha, a.head_sha, { repoRoot, limit: 50 });
        }
      } catch {
        payload.commits = [];
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderWorkspaceHtml(payload));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`workspace render failed: ${(err as Error).message}`);
  }
  return true;
}
