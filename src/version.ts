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
  version: '0.2.0',
  title: 'swrm v0.2.0 — Native + Multi-Project',
  notes: [
    '🖥️ **Native apps.** Mac & iOS. Point them at any folder of `.swrm/stories` and your board shows up — no localhost, no browser tab.',
    '⚡ **Live board.** Edit a story file on disk and the card moves itself. Quit mashing refresh.',
    '🗂️ **Two projects, no sweat.** Flip between repos right from the toolbar — or pop a second window and run two at once.',
    '🐝 **Fresh face.** New hive-cell app icon + browser favicon, so swrm\'s easy to spot in your dock and tabs.',
  ],
} as const;
