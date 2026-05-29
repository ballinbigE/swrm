// src/api/version.ts — GET /api/version
//
// Returns JSON with the current app version + What's New payload.
// Mirrors the self-contained handler style of favicon.ts.

import * as http from 'node:http';

import { appVersion, WHATS_NEW } from '../version';

/**
 * Handles GET /api/version.
 * Returns true if the request was handled (caller should return early).
 */
export function versionApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/api/version') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return true;
  }
  const body = JSON.stringify({ ...WHATS_NEW, version: appVersion() });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}
