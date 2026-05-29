// Tests for moveTask — reorder a task up/down within its board+status
// column by swapping `position` with the adjacent same-status sibling.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { createTask, moveTask } from '../tasks';
import { loadTaskList } from '../../views/tasks_list';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of ['001_init.sql', '003_attempts.sql', '004_attempt_comments.sql', '005_chat_message_scope.sql', '006_external_md_ref.sql', '007_attempts_repo_root.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('work', 'Work')`).run();
  return db;
}

/** Titles of backlog tasks in display order for the given board. */
function backlogOrder(db: Database.Database, board = 'personal'): string[] {
  return loadTaskList(db, { board, status: 'backlog' }).map((r) => r.title);
}

describe('moveTask', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('moves a card down past its neighbor (positions all default 0 → normalized then swapped)', () => {
    // created newest-first; loadTaskList tiebreaks id DESC, so display order is c,b,a
    const a = createTask(db, { title: 'a', status: 'backlog' });
    const b = createTask(db, { title: 'b', status: 'backlog' });
    const c = createTask(db, { title: 'c', status: 'backlog' });
    expect(backlogOrder(db)).toEqual(['c', 'b', 'a']);

    const moved = moveTask(db, c.id, 'down');
    expect(moved).toBe(true);
    expect(backlogOrder(db)).toEqual(['b', 'c', 'a']);
  });

  it('moves a card up past its neighbor', () => {
    createTask(db, { title: 'a', status: 'backlog' });
    const b = createTask(db, { title: 'b', status: 'backlog' });
    createTask(db, { title: 'c', status: 'backlog' }); // display: c,b,a
    const moved = moveTask(db, b.id, 'up');
    expect(moved).toBe(true);
    expect(backlogOrder(db)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op at the top edge (moved=false, order unchanged)', () => {
    createTask(db, { title: 'a', status: 'backlog' });
    const c = createTask(db, { title: 'c', status: 'backlog' }); // display: c,a (c on top)
    const moved = moveTask(db, c.id, 'up');
    expect(moved).toBe(false);
    expect(backlogOrder(db)).toEqual(['c', 'a']);
  });

  it('is a no-op at the bottom edge', () => {
    const a = createTask(db, { title: 'a', status: 'backlog' });
    createTask(db, { title: 'c', status: 'backlog' }); // display: c,a (a on bottom)
    const moved = moveTask(db, a.id, 'down');
    expect(moved).toBe(false);
    expect(backlogOrder(db)).toEqual(['c', 'a']);
  });

  it('only swaps within the same board AND status (never a neighbor in another column)', () => {
    const p = createTask(db, { title: 'p-backlog', status: 'backlog', board_id: 1 });
    createTask(db, { title: 'p-todo', status: 'todo', board_id: 1 });
    const work = db.prepare(`SELECT id FROM boards WHERE slug='work'`).get() as { id: number };
    createTask(db, { title: 'w-backlog', status: 'backlog', board_id: work.id });
    // p-backlog is the only backlog task on personal → no neighbor either way
    expect(moveTask(db, p.id, 'down')).toBe(false);
    expect(moveTask(db, p.id, 'up')).toBe(false);
  });

  it('returns false for a missing task', () => {
    expect(moveTask(db, 99999, 'up')).toBe(false);
  });
});
