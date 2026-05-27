// scripts/pm/api/sim_screenshot.ts — GET /api/sim/screenshot.png
//
// Captures the booted iOS simulator's screen via `xcrun simctl io booted
// screenshot -` (PNG to stdout) and serves it. Cached in-memory for
// MIN_INTERVAL_MS to avoid hammering the simulator when the workspace
// preview pane polls.
//
// On any host without a booted simulator (or non-darwin), returns a
// 1x1 transparent PNG so the iframe doesn't break the layout.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const MIN_INTERVAL_MS = 1500;

// 1x1 transparent PNG (base64) — fallback when simctl is unavailable or
// no simulator is booted.
const TRANSPARENT_PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface CacheEntry {
  png: Buffer;
  takenAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<Buffer> | null = null;

function spawnScreenshot(): Promise<Buffer> {
  // xcrun simctl writes to a file (it treats `-` as a literal filename, not
  // stdout). So pick a unique tmp path, capture there, read into buffer,
  // delete. Each call gets its own filename to avoid race between concurrent
  // requests (the in-flight Promise gate already serializes them, but the
  // tmp name is unique anyway for paranoia).
  const tmpFile = path.join(
    os.tmpdir(),
    `pm-sim-screenshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );

  return new Promise((resolve, reject) => {
    // execFile w/ array — no shell, no injection. `booted` resolves to the
    // first booted simulator; if none is booted, simctl exits non-zero.
    execFile(
      'xcrun',
      ['simctl', 'io', 'booted', 'screenshot', tmpFile],
      { timeout: 5000 },
      (err) => {
        if (err) {
          fs.promises.unlink(tmpFile).catch(() => {});
          return reject(err);
        }
        fs.promises
          .readFile(tmpFile)
          .then((buf) => {
            fs.promises.unlink(tmpFile).catch(() => {});
            resolve(buf);
          })
          .catch((readErr) => {
            fs.promises.unlink(tmpFile).catch(() => {});
            reject(readErr);
          });
      },
    );
  });
}

export async function getSimScreenshot(opts: { now?: number } = {}): Promise<{
  png: Buffer;
  source: 'live' | 'cache' | 'fallback';
}> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.takenAt < MIN_INTERVAL_MS) {
    return { png: cache.png, source: 'cache' };
  }
  if (inflight) {
    const png = await inflight;
    return { png, source: 'live' };
  }
  inflight = spawnScreenshot().finally(() => {
    inflight = null;
  });
  try {
    const png = await inflight;
    cache = { png, takenAt: now };
    return { png, source: 'live' };
  } catch {
    // Simulator not booted, non-darwin, xcrun missing. Don't break the
    // pane — return the placeholder PNG.
    return { png: TRANSPARENT_PX, source: 'fallback' };
  }
}

const SCREENSHOT_PATH = /^\/api\/sim\/screenshot\.png\/?$/;

export async function simScreenshotHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!SCREENSHOT_PATH.test(url.split('?')[0])) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  const { png, source } = await getSimScreenshot();
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'X-Source': source,
  });
  res.end(png);
  return true;
}

// Test seam: reset the in-memory cache so tests don't poison each other.
export function _resetSimScreenshotCache(): void {
  cache = null;
  inflight = null;
}
