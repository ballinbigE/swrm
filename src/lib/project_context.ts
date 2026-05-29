// swrm/src/lib/project_context.ts — resolve which project a request targets.
//
// Used by board/task views to scope data to a specific project. If no
// ?project=<slug> query param is given (or the slug is unknown), falls back
// to the first project ordered by position.

import type Database from 'better-sqlite3';

import { listProjects, ProjectRow } from '../api/projects';

export function resolveProject(db: Database.Database, url: URL): ProjectRow {
  const all = listProjects(db);
  if (all.length === 0) {
    throw new Error('[swrm] no projects found — run migrations first');
  }
  const want = url.searchParams.get('project');
  return (want && all.find((p) => p.slug === want)) || all[0];
}
