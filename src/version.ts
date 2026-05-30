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
  version: '0.5.0',
  title: 'swrm v0.5.0 — Git-Backed Moves',
  notes: [
    '🔗 **Every move is a commit.** Drag a card on the Mac board and swrm commits the `.md` change for you — like `sc-3: backlog → started`. One clean commit per move.',
    '🧊 **Best-effort, never in the way.** No git repo? The move still saves, just without a commit. (Mac only — git isn\'t on iOS.)',
  ],
} as const;
