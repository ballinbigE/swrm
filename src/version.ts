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
  version: '0.9.0',
  title: 'swrm v0.9.0 — Start Work',
  notes: [
    '🌿 **Start work on a card.** Right-click any card on the Mac board → "Start work" → swrm cuts the `sc-id/slug` branch and checks it out (or switches to it if it already exists).',
    '🔁 **Closes the loop.** Start work → drag to move (auto-commit) → Push & PR. The board and your git history finally move together.',
  ],
} as const;
