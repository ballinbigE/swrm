// scripts/pm/api/plan.ts — POST /api/plan handler.
// Body: { idea: string }
// Returns inline JSON of the parsed PRD; does NOT write a file. UI does
// the write step on confirm.

import * as http from 'node:http';

import { planFromIdea, MissingApiKeyError } from '../plan';

async function readBody(req: http.IncomingMessage, maxBytes = 200_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const PLAN_RE = /^\/api\/plan\/?$/;

export async function planApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!PLAN_RE.test(url.split('?')[0])) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: `method ${req.method} not allowed` });
    return true;
  }

  let body: { idea?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return true;
  }

  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (idea.length === 0) {
    sendJson(res, 400, { error: 'idea (non-empty string) is required' });
    return true;
  }

  try {
    const prd = await planFromIdea(idea);
    sendJson(res, 200, { prd });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      sendJson(res, 503, { error: err.message, hint: 'export ANTHROPIC_API_KEY before booting the pm dashboard' });
      return true;
    }
    sendJson(res, 500, { error: (err as Error).message });
  }
  return true;
}
