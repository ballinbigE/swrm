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
  version: '0.4.0',
  title: 'swrm v0.4.0 — Drag to Move',
  notes: [
    '✏️ **Drag to move (for real).** Drag a card to another column on the Mac/iOS board and it sticks — written straight back to the `.md` file.',
    '🪶 **Surgical saves.** Only the one line that changed gets rewritten. Your file\'s body, comments, and other fields stay exactly as you left them.',
    '🐝 **Live + no fighting.** The move shows instantly and the file-watcher won\'t double-fire over your drag.',
  ],
} as const;
