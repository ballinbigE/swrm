// US-011 — skill MCP tools.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { TOOLS, callTool } from '../tools';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

function insert(db: Database.Database): number {
  return db.prepare(
    `INSERT INTO skills (name, project, type, frequency, side_effects, command, mcp)
     VALUES ('s', 'p', 'command', '1h', 'read-only', 'echo x', '["Gmail"]')`,
  ).run().lastInsertRowid as number;
}

describe('skill MCP tools (US-011)', () => {
  it('registers list_skills, run_skill, get_skill_runs', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('swrm__list_skills');
    expect(names).toContain('swrm__run_skill');
    expect(names).toContain('swrm__get_skill_runs');
  });

  it('list_skills returns the skills as JSON text', async () => {
    const db = makeDb();
    insert(db);
    const content = await callTool('swrm__list_skills', {}, db);
    expect(content[0].text).toContain('"name": "s"');
    expect(content[0].text).toContain('Gmail');
  });

  it('get_skill_runs returns run history for a skill', async () => {
    const db = makeDb();
    const id = insert(db);
    db.prepare(`INSERT INTO agent_runs (agent_name, action, status, skill_id, notes) VALUES ('s','skill-run','ok',?, 'hi')`).run(id);
    const content = await callTool('swrm__get_skill_runs', { id }, db);
    expect(content[0].text).toContain('hi');
  });

  it('run_skill triggers a run and reports status', async () => {
    const db = makeDb();
    const id = insert(db);
    const content = await callTool('swrm__run_skill', { id }, db);
    expect(content[0].text).toMatch(/ok|error|skipped/);
    const row = db.prepare(`SELECT last_status FROM skills WHERE id = ?`).get(id) as { last_status: string };
    expect(['ok', 'error']).toContain(row.last_status);
  });
});
