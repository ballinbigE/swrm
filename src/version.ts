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
  version: '0.3.0',
  title: 'swrm v0.3.0 — Projects on the Web',
  notes: [
    '🗂️ **Projects on the web.** Register a project in Settings, switch from the dropdown, or keep two tabs open side by side — each pinned to its own repo.',
    '🔭 **Everything scopes per project.** Boards, tasks, markdown sync, and skill runs all stay in their own lane — no cross-project bleed.',
    '🍯 **One swrm, every surface.** Project switching now lives on Mac, iOS, and the web.',
  ],
} as const;
