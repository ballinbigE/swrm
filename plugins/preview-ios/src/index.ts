// @loom/preview-ios — iOS Simulator screenshot preview plugin.
//
// Captures the booted iPhone via `xcrun simctl io booted screenshot
// <tmpfile>` (simctl treats `-` as a literal filename, not stdout),
// reads the file, deletes it, returns the PNG bytes. Cached in-memory
// for MIN_INTERVAL_MS to spare the simulator under polling. Falls back
// to a 1×1 transparent PNG on non-darwin / no booted sim — keeps the
// loom iframe layout intact.
//
// macOS + Xcode required for non-fallback behavior.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// PreviewPlugin contract imported from the loom package. We use a local
// shape declaration here so plugin can build stand-alone without loom in
// node_modules — the runtime contract is duck-typed.
interface PreviewContext {
  task: { id: number; title: string; description: string | null; status: string };
  attempt?: { repo_root?: string };
  repoRoot: string;
}
interface PreviewResult {
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}
interface PreviewPlugin {
  name: string;
  match(ctx: PreviewContext): boolean | Promise<boolean>;
  render(ctx: PreviewContext): Promise<PreviewResult>;
  dispose?(): Promise<void>;
}

const MIN_INTERVAL_MS = 1500;

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
  const tmpFile = path.join(
    os.tmpdir(),
    `loom-sim-screenshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );

  return new Promise((resolve, reject) => {
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

async function getSimScreenshot(opts: { now?: number } = {}): Promise<{ png: Buffer; source: 'live' | 'cache' | 'fallback' }> {
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
    return { png: TRANSPARENT_PX, source: 'fallback' };
  }
}

const plugin: PreviewPlugin = {
  name: 'preview-ios',

  match(ctx: PreviewContext): boolean {
    try {
      return fs.existsSync(path.join(ctx.repoRoot, 'ios'));
    } catch {
      return false;
    }
  },

  async render(_ctx: PreviewContext): Promise<PreviewResult> {
    const { png, source } = await getSimScreenshot();
    return {
      contentType: 'image/png',
      body: png,
      headers: { 'X-Source': source },
    };
  },
};

export default plugin;

// Test seam — reset the in-memory cache between cases.
export function _resetSimScreenshotCache(): void {
  cache = null;
  inflight = null;
}
