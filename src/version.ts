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
  version: '0.8.0',
  title: 'swrm v0.8.0 — Push & Open PR',
  notes: [
    '🚀 **Push & open a PR.** One button on the Mac board pushes your current branch to GitHub and opens a pull request into your default branch. Then "Open PR" jumps you straight there.',
    '🔐 **Your token stays put.** Push auth rides in a transient request header — never written to git config, the remote URL, or any log. (Mac only.)',
  ],
} as const;
