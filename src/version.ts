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
  version: '1.0.0',
  title: 'swrm v1.0.0 — The Loop Closes 🐝',
  notes: [
    '🎉 **swrm 1.0.** A real Mac & iOS app: open a folder of `.swrm/stories`, drag cards (each move auto-commits), connect GitHub, watch live CI, start work on a branch, push & open a PR — and now close the loop.',
    '✅ **New: Mark done if merged.** Right-click a card → swrm asks GitHub; if its PR has merged, the card moves to Done with a clean commit.',
    '🔁 **End to end:** Start work → move (commit) → Push & PR → Mark done on merge.',
  ],
} as const;
