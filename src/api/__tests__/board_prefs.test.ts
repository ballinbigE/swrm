import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { getBoardPrefs, parseWorkflow, updateBoardPrefs, PrefsError } from '../board_prefs';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of [
    '001_init.sql', '003_attempts.sql', '004_attempt_comments.sql',
    '005_chat_message_scope.sql', '006_external_md_ref.sql',
    '007_attempts_repo_root.sql', '008_board_workflow.sql',
  ]) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  return db;
}

describe('parseWorkflow', () => {
  it('defaults to the five on null/garbage', () => {
    expect(parseWorkflow(null)).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
    expect(parseWorkflow('not json')).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
    expect(parseWorkflow('[]')).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
  it('parses a valid array', () => {
    expect(parseWorkflow('["todo","done"]')).toEqual(['todo', 'done']);
  });
});

describe('getBoardPrefs', () => {
  it('returns default workflow + color for a fresh board', () => {
    const db = makeDb();
    const p = getBoardPrefs(db, 1);
    expect(p.color).toBe('#d97757');
    expect(p.workflow).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
});

describe('updateBoardPrefs', () => {
  it('updates color', () => {
    const db = makeDb();
    const p = updateBoardPrefs(db, 1, { color: '#4ade80' });
    expect(p.color).toBe('#4ade80');
  });
  it('rejects bad color', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, { color: 'green' })).toThrow(/invalid color/);
    expect(() => updateBoardPrefs(db, 1, { color: '#fff' })).toThrow(/invalid color/);
  });
  it('updates workflow + persists order', () => {
    const db = makeDb();
    const p = updateBoardPrefs(db, 1, { workflow: ['todo', 'in_progress', 'shipped'] });
    expect(p.workflow).toEqual(['todo', 'in_progress', 'shipped']);
    expect(getBoardPrefs(db, 1).workflow).toEqual(['todo', 'in_progress', 'shipped']);
  });
  it('rejects unknown status', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, { workflow: ['todo', 'banana'] })).toThrow(/unknown status 'banana'/);
  });
  it('rejects empty workflow', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, { workflow: [] })).toThrow(/non-empty array/);
  });
  it('rejects duplicate status', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, { workflow: ['todo', 'todo'] })).toThrow(/duplicate status/);
  });
  it('updates name', () => {
    const db = makeDb();
    expect(updateBoardPrefs(db, 1, { name: 'Renamed' }).name).toBe('Renamed');
  });
  it('rejects empty name', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, { name: '   ' })).toThrow(/name cannot be empty/);
  });
  it('errors on empty patch', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 1, {})).toThrow(/patch is empty/);
  });
  it('404 on unknown board', () => {
    const db = makeDb();
    expect(() => updateBoardPrefs(db, 999, { color: '#000000' })).toThrow(PrefsError);
  });
});
