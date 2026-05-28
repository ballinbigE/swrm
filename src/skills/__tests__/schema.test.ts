// US-001 + US-002 — Skill Card schema + agent_runs link.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { SKILL_TYPES, SIDE_EFFECTS, SKILL_STATUSES } from '../types';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

describe('skills schema (US-001)', () => {
  it('inserts a minimal skill and applies defaults', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO skills (name, project, type, frequency, side_effects)
       VALUES ('contact-listener', 'nugget-expo', 'agent', '@daily', 'read-only')`,
    ).run();
    const row = db.prepare(`SELECT * FROM skills WHERE name = 'contact-listener'`).get() as Record<string, unknown>;
    expect(row.enabled).toBe(1);
    expect(row.last_status).toBe('idle');
    expect(row.needs_worktree).toBe(0);
    expect(row.timeout).toBe(600);
    expect(row.on_findings).toBe('append');
    expect(row.updated_at).toBeTruthy();
  });

  it('enforces unique (name, project)', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO skills (name, project, type, frequency, side_effects)
       VALUES ('x', 'p', 'command', '1h', 'writes')`,
    );
    ins.run();
    expect(() => ins.run()).toThrow();
  });

  it('exposes the type/side-effect/status vocabularies', () => {
    expect(SKILL_TYPES).toEqual(['agent', 'command']);
    expect(SIDE_EFFECTS).toEqual(['read-only', 'writes', 'external']);
    expect(SKILL_STATUSES).toEqual(['idle', 'running', 'ok', 'error', 'skipped']);
  });
});

describe('agent_runs skill link (US-002)', () => {
  it('links a run to a skill via skill_id and stores timing + findings', () => {
    const db = makeDb();
    const skill = db.prepare(
      `INSERT INTO skills (name, project, type, frequency, side_effects)
       VALUES ('contact-listener', 'nugget-expo', 'agent', '@daily', 'read-only')`,
    ).run();
    const skillId = skill.lastInsertRowid as number;

    db.prepare(
      `INSERT INTO agent_runs (agent_name, action, status, skill_id, finished_at, findings_count, notes)
       VALUES ('contact-listener', 'skill-run', 'ok', ?, datetime('now'), 3, '3 new contacts')`,
    ).run(skillId);

    const run = db.prepare(`SELECT * FROM agent_runs WHERE skill_id = ?`).get(skillId) as Record<string, unknown>;
    expect(run.skill_id).toBe(skillId);
    expect(run.findings_count).toBe(3);
    expect(run.finished_at).toBeTruthy();
  });

  it('does not break legacy agent_runs inserts (skill_id nullable)', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO agent_runs (agent_name, action, status, notes)
       VALUES ('bug_fix', 'ingest', 'ok', 'legacy row')`,
    ).run();
    const run = db.prepare(`SELECT skill_id, findings_count FROM agent_runs WHERE agent_name = 'bug_fix'`).get() as Record<string, unknown>;
    expect(run.skill_id).toBeNull();
    expect(run.findings_count).toBeNull();
  });
});
