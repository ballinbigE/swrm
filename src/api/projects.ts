// swrm/src/api/projects.ts — CRUD for projects.
//
// Endpoints:
//   GET    /api/projects          — list all projects ordered by position
//   POST   /api/projects          — create a project
//   PATCH  /api/projects/:id      — update name / color / root_path
//
// Mirror the error-class + handler-returns-boolean pattern from board_prefs.ts.

import * as fs from 'node:fs';
import * as http from 'node:http';

import type Database from 'better-sqlite3';

import { getDb } from '../db';

// ── types ──────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  root_path: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export class ProjectError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// ── validation ─────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ProjectError(
      400,
      `invalid slug '${slug}' (must match /^[a-z][a-z0-9-]{1,39}$/)`,
    );
  }
}

function validateRootPath(root_path: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root_path);
  } catch {
    throw new ProjectError(400, `root_path does not exist: ${root_path}`);
  }
  if (!stat.isDirectory()) {
    throw new ProjectError(400, `root_path is not a directory: ${root_path}`);
  }
}

// ── pure query helpers ─────────────────────────────────────────────────

export function listProjects(db: Database.Database): ProjectRow[] {
  return db
    .prepare(`SELECT * FROM projects ORDER BY position, id`)
    .all() as ProjectRow[];
}

export function getProjectBySlug(db: Database.Database, slug: string): ProjectRow | undefined {
  return db
    .prepare(`SELECT * FROM projects WHERE slug = ?`)
    .get(slug) as ProjectRow | undefined;
}

// ── write helpers ──────────────────────────────────────────────────────

export interface CreateProjectInput {
  slug: string;
  name: string;
  root_path: string;
  color?: string;
}

export function createProject(db: Database.Database, input: CreateProjectInput): ProjectRow {
  const { slug, name, root_path } = input;
  const color = input.color ?? '#d97757';

  validateSlug(slug);
  validateRootPath(root_path);

  const existing = db.prepare(`SELECT 1 FROM projects WHERE slug = ?`).get(slug);
  if (existing) {
    throw new ProjectError(409, `project with slug '${slug}' already exists`);
  }

  const maxPos = (
    db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM projects`).get() as { m: number }
  ).m;

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO projects (slug, name, root_path, color, position)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(slug, name.trim(), root_path, color, maxPos + 1);
    const projectId = result.lastInsertRowid as number;
    // Seed one board so the project is usable immediately — the board view
    // renders nothing without at least one board. Board slug = project slug
    // (globally unique among boards in practice for a fresh project slug).
    db.prepare(
      `INSERT INTO boards (slug, name, color, position, project_id)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(slug) DO NOTHING`,
    ).run(slug, name.trim(), color, projectId);
    return projectId;
  });
  const projectId = tx();

  return db
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(projectId) as ProjectRow;
}

export interface UpdateProjectPatch {
  name?: string;
  color?: string;
  root_path?: string;
}

export function updateProject(
  db: Database.Database,
  id: number,
  patch: UpdateProjectPatch,
): ProjectRow {
  const existing = db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(id);
  if (!existing) {
    throw new ProjectError(404, `project ${id} not found`);
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) throw new ProjectError(400, 'name cannot be empty');
    if (name.length > 80) throw new ProjectError(400, 'name too long (max 80)');
    sets.push(`name = @name`);
    params.name = name;
  }
  if (patch.color !== undefined) {
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    if (!HEX_RE.test(patch.color)) {
      throw new ProjectError(400, `invalid color (need #rrggbb): ${patch.color}`);
    }
    sets.push(`color = @color`);
    params.color = patch.color;
  }
  if (patch.root_path !== undefined) {
    validateRootPath(patch.root_path);
    sets.push(`root_path = @root_path`);
    params.root_path = patch.root_path;
  }

  if (sets.length === 0) throw new ProjectError(400, 'patch is empty');
  sets.push(`updated_at = datetime('now')`);

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = @id`).run(params);

  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow;
}

// ── http handler ───────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, maxBytes = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PROJECTS_LIST_PATH = '/api/projects';
const PROJECT_ID_RE = /^\/api\/projects\/(\d+)\/?$/;

// Returns true if handled; false to let outer router fall through.
export async function projectsApiHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database = getDb(),
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  // GET /api/projects
  if (method === 'GET' && url === PROJECTS_LIST_PATH) {
    try {
      sendJson(res, 200, { projects: listProjects(db) });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
    return true;
  }

  // POST /api/projects
  if (method === 'POST' && url === PROJECTS_LIST_PATH) {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      return true;
    }
    try {
      const project = createProject(db, body as CreateProjectInput);
      sendJson(res, 201, { project });
    } catch (err) {
      const e = err as ProjectError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  // PATCH /api/projects/:id
  const m = url.match(PROJECT_ID_RE);
  if (method === 'PATCH' && m) {
    const id = Number(m[1]);
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'invalid project id' });
      return true;
    }
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
      return true;
    }
    try {
      const project = updateProject(db, id, body as UpdateProjectPatch);
      sendJson(res, 200, { project });
    } catch (err) {
      const e = err as ProjectError;
      sendJson(res, e.status ?? 500, { error: e.message });
    }
    return true;
  }

  return false;
}
