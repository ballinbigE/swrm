// src/version.ts — single source of truth for app version + What's New copy.
//
// appVersion() reads the version field from the top-level package.json at
// runtime (same approach as cli.ts). WHATS_NEW holds the canonical v0.2.0
// release copy; the web /whats-new route and /api/version endpoint both draw
// from this module.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Read the current app version from package.json. Falls back to '0.0.0'. */
export function appVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Canonical What's New content for the current release. */
export const WHATS_NEW = {
  version: '0.7.0',
  title: 'swrm v0.7.0 — Live CI on the Board',
  notes: [
    '🚦 **Live CI badge.** Connected your GitHub? The Mac board shows a Passing / Failing / Running pill for your repo\'s HEAD, straight from GitHub check-runs. Tap it to refresh.',
    '🪟 **Read-only by design.** A live peek at your checks — fetched fresh, never stored, never written to your files. (Mac only — needs git to find the repo.)',
  ],
} as const;
