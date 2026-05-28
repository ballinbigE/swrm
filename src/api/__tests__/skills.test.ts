// US-008 (run now) + US-010 (enable/pause + card write-back) + list/runs.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { getSkillRuns, listSkills, runSkillNow, setSkillEnabled } from '../skills';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

const CARD = ['---', 'name: s', 'project: p', 'type: command', 'frequency: 1h', 'side_effects: read-only', 'enabled: true', '---', '# S', ''].join('\n');

function insert(db: Database.Database, filePath: string | null = null): number {
  const r = db.prepare(
    `INSERT INTO skills (name, project, type, frequency, side_effects, command, mcp, file_path)
     VALUES ('s', 'p', 'command', '1h', 'read-only', 'echo x', '["Gmail"]', ?)`,
  ).run(filePath);
  return r.lastInsertRowid as number;
}

const okRunner = async () => ({ status: 'ok' as const });

describe('runSkillNow (US-008)', () => {
  it('runs a skill regardless of schedule and updates last_status', async () => {
    const db = makeDb();
    const id = insert(db);
    const res = await runSkillNow(db, id, { runner: okRunner });
    expect(res).toEqual({ status: 'ok' });
    const row = db.prepare(`SELECT last_status, last_run FROM skills WHERE id = ?`).get(id) as Record<string, string>;
    expect(row.last_status).toBe('ok');
    expect(row.last_run).toBeTruthy();
  });

  it('throws for an unknown skill id', async () => {
    const db = makeDb();
    await expect(runSkillNow(db, 999, { runner: okRunner })).rejects.toThrow();
  });
});

describe('setSkillEnabled (US-010)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('flips enabled in DB and rewrites the card frontmatter line', () => {
    const f = path.join(dir, 's.skill.md');
    fs.writeFileSync(f, CARD);
    const db = makeDb();
    const id = insert(db, f);

    setSkillEnabled(db, id, false);

    expect((db.prepare(`SELECT enabled FROM skills WHERE id = ?`).get(id) as { enabled: number }).enabled).toBe(0);
    expect(fs.readFileSync(f, 'utf8')).toContain('enabled: false');
    expect(fs.readFileSync(f, 'utf8')).not.toContain('enabled: true');
  });

  it('tolerates a skill with no card file (DB-only flip)', () => {
    const db = makeDb();
    const id = insert(db, null);
    setSkillEnabled(db, id, false);
    expect((db.prepare(`SELECT enabled FROM skills WHERE id = ?`).get(id) as { enabled: number }).enabled).toBe(0);
  });
});

describe('listSkills + getSkillRuns', () => {
  it('lists skills with parsed mcp + enabled boolean', () => {
    const db = makeDb();
    insert(db);
    const skills = listSkills(db);
    expect(skills).toHaveLength(1);
    expect(skills[0].enabled).toBe(true);
    expect(skills[0].mcp).toEqual(['Gmail']);
  });

  it('returns run history newest first', async () => {
    const db = makeDb();
    const id = insert(db);
    db.prepare(`INSERT INTO agent_runs (agent_name, action, status, skill_id, notes) VALUES ('s','skill-run','ok',?, 'first')`).run(id);
    db.prepare(`INSERT INTO agent_runs (agent_name, action, status, skill_id, notes) VALUES ('s','skill-run','error',?, 'second')`).run(id);
    const runs = getSkillRuns(db, id);
    expect(runs).toHaveLength(2);
    expect(runs[0].notes).toBe('second');
  });
});
