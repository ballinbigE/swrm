// scripts/pm/api/workspace_stream.ts — SSE channel per task. Replaces
// full-page reloads in the workspace view; clients open an EventSource
// to /api/workspace/:taskId/stream and patch DOM in place.
//
// Other handlers call broadcast(taskId, event, data) after their DB
// write; this module fans out to all currently-connected clients on
// that task and ignores broken pipes.
//
// In-memory only (no Redis); single-process; no auth (localhost-bound
// per pm-dashboard hook).

import * as http from 'node:http';

interface Client {
  res: http.ServerResponse;
  taskId: number;
  keepaliveTimer: NodeJS.Timeout;
}

const clients = new Set<Client>();

const KEEPALIVE_MS = 25000;

function writeSse(res: http.ServerResponse, event: string, data: unknown): boolean {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function broadcast(taskId: number, event: string, data: unknown): number {
  let count = 0;
  for (const c of clients) {
    if (c.taskId !== taskId) continue;
    if (writeSse(c.res, event, data)) count += 1;
    else dropClient(c);
  }
  return count;
}

function dropClient(c: Client): void {
  clearInterval(c.keepaliveTimer);
  clients.delete(c);
  try { c.res.end(); } catch { /* already closed */ }
}

const STREAM_RE = /^\/api\/workspace\/(\d+)\/stream\/?$/;

export function workspaceStreamHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = req.url ?? '/';
  const m = url.split('?')[0].match(STREAM_RE);
  if (!m) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return true;
  }

  const taskId = Number(m[1]);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Initial hello so the client knows we're up
  writeSse(res, 'hello', { taskId, ts: Date.now() });

  const keepaliveTimer = setInterval(() => {
    if (!writeSse(res, 'ping', { ts: Date.now() })) dropClient(client);
  }, KEEPALIVE_MS);

  const client: Client = { res, taskId, keepaliveTimer };
  clients.add(client);

  req.on('close', () => dropClient(client));
  return true;
}

// Test helpers
export function _activeClientsForTask(taskId: number): number {
  let n = 0;
  for (const c of clients) if (c.taskId === taskId) n += 1;
  return n;
}
export function _resetStreamClients(): void {
  for (const c of clients) dropClient(c);
}
