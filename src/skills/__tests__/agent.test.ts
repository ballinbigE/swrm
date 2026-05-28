// US-006 — agent executor (no worktree by default; MCP allowlist via env).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runAgentSkill } from '../agent';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

const CARD = ['---', 'name: a', 'project: p', 'type: agent', 'frequency: 1h', 'side_effects: read-only', 'agent: claude', '---', '# Listener', '', 'scan-the-inbox-body'].join('\n');

function insertAgentSkill(db: Database.Database, filePath: string): number {
  const r = db.prepare(
    `INSERT INTO skills (name, project, type, frequency, side_effects, agent, mcp, file_path)
     VALUES ('a', 'p', 'agent', '1h', 'read-only', 'claude', '["Gmail","Firebase"]', ?)`,
  ).run(filePath);
  return r.lastInsertRowid as number;
}

describe('runAgentSkill (US-006)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('spawns the agent with the card body as prompt and records ok', async () => {
    const db = makeDb();
    const f = path.join(dir, 'a.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertAgentSkill(db, f);

    const res = await runAgentSkill(
      db,
      { id, name: 'a', agent: 'claude', mcp: ['Gmail', 'Firebase'], timeout: 600, file_path: f, needs_worktree: false },
      { cwd: dir, binary: 'echo' },
    );

    expect(res.status).toBe('ok');
    expect(res.summary).toContain('scan-the-inbox-body');
    const run = db.prepare(`SELECT status FROM agent_runs WHERE skill_id = ?`).get(id) as { status: string };
    expect(run.status).toBe('ok');
    expect(fs.readFileSync(f, 'utf8')).toContain('## Runs');
  });

  it('exposes only the allowed MCP servers via SWRM_SKILL_MCP', async () => {
    const db = makeDb();
    const f = path.join(dir, 'a.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertAgentSkill(db, f);

    const res = await runAgentSkill(
      db,
      { id, name: 'a', agent: 'claude', mcp: ['Gmail', 'Firebase'], timeout: 600, file_path: f, needs_worktree: false },
      { cwd: dir, binary: 'sh', args: ['-c', 'echo "$SWRM_SKILL_MCP"'] },
    );

    expect(res.summary).toContain('Gmail');
    expect(res.summary).toContain('Firebase');
  });

  it('records error when the agent binary exits non-zero', async () => {
    const db = makeDb();
    const f = path.join(dir, 'a.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertAgentSkill(db, f);

    const res = await runAgentSkill(
      db,
      { id, name: 'a', agent: 'claude', mcp: [], timeout: 600, file_path: f, needs_worktree: false },
      { cwd: dir, binary: 'false' },
    );

    expect(res.status).toBe('error');
    const run = db.prepare(`SELECT status FROM agent_runs WHERE skill_id = ?`).get(id) as { status: string };
    expect(run.status).toBe('error');
  });
});
