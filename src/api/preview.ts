// swrm/src/api/preview.ts — GET /api/preview/:taskId
// Iterates registered PreviewPlugin instances, first match wins, returns
// 404 if none. Core knows nothing about iOS / web / Storybook — those are
// plugin concerns.

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';
import { getAttempt } from './attempts';
import { pickPlugin } from '../plugins/preview';

const PREVIEW_RE = /^\/api\/preview\/(\d+)\/?$/;

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
}

export async function previewHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const url = req.url ?? '/';
  const m = url.split('?')[0].match(PREVIEW_RE);
  if (!m) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }

  const taskId = Number(m[1]);
  const task = db
    .prepare(`SELECT id, title, description, status FROM tasks WHERE id = ? AND archived_at IS NULL`)
    .get(taskId) as TaskRow | undefined;
  if (!task) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `task ${taskId} not found` }));
    return true;
  }

  // Use the latest attempt for plugin matching context, if any.
  const attempts = db
    .prepare(`SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1`)
    .all(taskId) as unknown[];
  const attempt = attempts[0] ? getAttempt(db, (attempts[0] as { id: number }).id) : undefined;

  const repoRoot = attempt?.repo_root && attempt.repo_root.length > 0
    ? attempt.repo_root
    : process.cwd();

  const ctx = {
    task,
    attempt: attempt ?? undefined,
    repoRoot,
  };

  const plugin = await pickPlugin(ctx);
  if (!plugin) {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'X-Plugin': 'none',
    });
    res.end(JSON.stringify({
      error: 'no preview plugin matched',
      hint: 'install a plugin (e.g. @swrm/preview-ios) + add it to .swrmrc.json',
    }));
    return true;
  }

  try {
    const result = await plugin.render(ctx);
    res.writeHead(200, {
      'Content-Type': result.contentType,
      'Cache-Control': 'no-store',
      'X-Plugin': plugin.name,
      ...result.headers,
    });
    res.end(result.body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'X-Plugin': plugin.name });
    res.end(JSON.stringify({ error: (err as Error).message, plugin: plugin.name }));
  }
  return true;
}
