// US-005 — command executor + card Runs write-back.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { runCommandSkill } from '../executor';
import { appendRunToCard } from '../runlog';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '009_skills.sql', '010_agent_runs_skill_link.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  return db;
}

function insertSkill(db: Database.Database, command: string, filePath: string, timeout = 600): number {
  const r = db.prepare(
    `INSERT INTO skills (name, project, type, frequency, side_effects, command, timeout, file_path)
     VALUES ('cmd-skill', 'p', 'command', '1h', 'read-only', ?, ?, ?)`,
  ).run(command, timeout, filePath);
  return r.lastInsertRowid as number;
}

const CARD = ['---', 'name: cmd-skill', 'project: p', 'type: command', 'frequency: 1h', 'side_effects: read-only', '---', '# Cmd Skill', ''].join('\n');

describe('appendRunToCard (US-005)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates a ## Runs section and adds an entry', () => {
    const f = path.join(dir, 'c.skill.md');
    fs.writeFileSync(f, CARD);
    appendRunToCard(f, { when: '2026-05-27 07:00', status: 'ok', durationMs: 1200, summary: 'did the thing' });
    const txt = fs.readFileSync(f, 'utf8');
    expect(txt).toContain('## Runs');
    expect(txt).toMatch(/### 2026-05-27 07:00 — ok \(1\.2s\)/);
    expect(txt).toContain('did the thing');
  });

  it('puts newest entry first and caps at 20', () => {
    const f = path.join(dir, 'c.skill.md');
    fs.writeFileSync(f, CARD);
    for (let i = 1; i <= 25; i += 1) {
      appendRunToCard(f, { when: `entry-${i}`, status: 'ok', durationMs: 0, summary: `s${i}` });
    }
    const txt = fs.readFileSync(f, 'utf8');
    const entries = txt.match(/^### /gm) ?? [];
    expect(entries.length).toBe(20);
    // newest (entry-25) appears before older (entry-6); entry-1..5 trimmed
    expect(txt.indexOf('entry-25')).toBeLessThan(txt.indexOf('entry-6'));
    expect(txt).not.toContain('entry-1\n');
  });
});

describe('runCommandSkill (US-005)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs a successful command, records an agent_runs row, appends the card', async () => {
    const db = makeDb();
    const f = path.join(dir, 'c.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertSkill(db, 'echo hello-from-skill', f);

    const res = await runCommandSkill(db, { id, name: 'cmd-skill', command: 'echo hello-from-skill', timeout: 600, file_path: f }, { cwd: dir });

    expect(res.status).toBe('ok');
    const run = db.prepare(`SELECT * FROM agent_runs WHERE skill_id = ?`).get(id) as Record<string, unknown>;
    expect(run.status).toBe('ok');
    expect(run.finished_at).toBeTruthy();
    expect(String(run.notes)).toContain('hello-from-skill');
    expect(fs.readFileSync(f, 'utf8')).toContain('## Runs');
  });

  it('captures a non-zero exit as error without throwing', async () => {
    const db = makeDb();
    const f = path.join(dir, 'c.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertSkill(db, 'exit 3', f);

    const res = await runCommandSkill(db, { id, name: 'cmd-skill', command: 'sh -c "echo boom >&2; exit 3"', timeout: 600, file_path: f }, { cwd: dir });

    expect(res.status).toBe('error');
    const run = db.prepare(`SELECT status FROM agent_runs WHERE skill_id = ?`).get(id) as { status: string };
    expect(run.status).toBe('error');
  });

  it('kills a command that exceeds its timeout (status error)', async () => {
    const db = makeDb();
    const f = path.join(dir, 'c.skill.md');
    fs.writeFileSync(f, CARD);
    const id = insertSkill(db, 'sleep', f, 1);

    const res = await runCommandSkill(
      db,
      { id, name: 'cmd-skill', command: 'node -e "setTimeout(()=>{}, 5000)"', timeout: 1, file_path: f },
      { cwd: dir },
    );
    expect(res.status).toBe('error');
  });
});
