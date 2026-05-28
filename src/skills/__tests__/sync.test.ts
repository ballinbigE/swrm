// US-003 — Skill Card markdown -> SQLite sync.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { parseSkillCard, syncSkillsDir } from '../sync';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

const CARD = [
  '---',
  'name: contact-listener',
  'project: nugget-expo',
  'type: agent',
  'enabled: true',
  'frequency: "@daily 07:00"',
  'side_effects: read-only',
  'timeout: 600',
  'agent: claude',
  'needs_worktree: false',
  'mcp: [Gmail, Firebase]',
  'on_findings: append',
  '---',
  '# Contact Listener',
  '',
  'Scan the inbox and surface new contacts.',
].join('\n');

describe('parseSkillCard (US-003)', () => {
  it('parses frontmatter into typed fields', () => {
    const c = parseSkillCard(CARD);
    expect(c.name).toBe('contact-listener');
    expect(c.project).toBe('nugget-expo');
    expect(c.type).toBe('agent');
    expect(c.enabled).toBe(true);
    expect(c.frequency).toBe('@daily 07:00');
    expect(c.side_effects).toBe('read-only');
    expect(c.timeout).toBe(600);
    expect(c.agent).toBe('claude');
    expect(c.needs_worktree).toBe(false);
    expect(c.mcp).toEqual(['Gmail', 'Firebase']);
    expect(c.on_findings).toBe('append');
    expect(c.body).toContain('# Contact Listener');
    expect(c.body_hash).toMatch(/^[a-f0-9]{12,}$/);
  });

  it('throws on a card missing frontmatter', () => {
    expect(() => parseSkillCard('# no frontmatter here')).toThrow();
  });
});

describe('syncSkillsDir (US-003)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeCard(file: string, text: string): void {
    fs.writeFileSync(path.join(dir, file), text);
  }

  it('inserts a new card with body_hash set', () => {
    writeCard('contact.skill.md', CARD);
    const db = makeDb();
    const r = syncSkillsDir(db, dir);
    expect(r.inserted).toBe(1);
    const row = db.prepare(`SELECT * FROM skills WHERE name = 'contact-listener'`).get() as Record<string, unknown>;
    expect(row.enabled).toBe(1);
    expect(row.body_hash).toBeTruthy();
    expect(row.file_path).toContain('contact.skill.md');
  });

  it('skips an unchanged card on the second sync', () => {
    writeCard('contact.skill.md', CARD);
    const db = makeDb();
    syncSkillsDir(db, dir);
    const r2 = syncSkillsDir(db, dir);
    expect(r2.inserted).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  it('updates a card whose body changed', () => {
    writeCard('contact.skill.md', CARD);
    const db = makeDb();
    syncSkillsDir(db, dir);
    writeCard('contact.skill.md', CARD + '\n\nNow with an extra line.');
    const r = syncSkillsDir(db, dir);
    expect(r.updated).toBe(1);
  });

  it('soft-disables a card set to enabled:false (does not delete)', () => {
    writeCard('contact.skill.md', CARD);
    const db = makeDb();
    syncSkillsDir(db, dir);
    writeCard('contact.skill.md', CARD.replace('enabled: true', 'enabled: false'));
    syncSkillsDir(db, dir);
    const row = db.prepare(`SELECT enabled FROM skills WHERE name = 'contact-listener'`).get() as { enabled: number };
    expect(row.enabled).toBe(0);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('soft-disables a skill whose file was removed', () => {
    writeCard('contact.skill.md', CARD);
    const db = makeDb();
    syncSkillsDir(db, dir);
    fs.rmSync(path.join(dir, 'contact.skill.md'));
    syncSkillsDir(db, dir);
    const row = db.prepare(`SELECT enabled FROM skills WHERE name = 'contact-listener'`).get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });
});
