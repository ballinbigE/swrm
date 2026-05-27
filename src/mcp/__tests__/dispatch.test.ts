// Tests for the MCP JSON-RPC dispatcher.
// Uses an in-memory SQLite DB seeded with the prod schema + one board.

import * as fs from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { dispatch } from '../dispatch';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(
    path.join(__dirname, '..', '..', 'migrations', '001_init.sql'),
    'utf8',
  );
  (db as { exec(s: string): void }).exec(schema);
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('work', 'Work')`).run();
  return db;
}

describe('dispatch: initialize', () => {
  it('returns server capabilities + name', async () => {
    const db = makeDb();
    const resp = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, db);
    expect(resp).not.toBeNull();
    expect(resp!.id).toBe(1);
    expect((resp!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('nugget-pm');
    expect((resp!.result as { capabilities: { tools: object } }).capabilities.tools).toEqual({});
  });
});

describe('dispatch: tools/list', () => {
  it('enumerates the loom__* tools', async () => {
    const db = makeDb();
    const resp = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, db);
    const tools = (resp!.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('loom__list_boards');
    expect(names).toContain('loom__list_tasks');
    expect(names).toContain('loom__create_task');
    expect(names).toContain('loom__update_task');
    expect(names).toContain('loom__get_task');
    expect(names).toContain('loom__list_epics');
    expect(names).toContain('loom__suggestions_today');
  });

  it('every tool has name, description, inputSchema', async () => {
    const db = makeDb();
    const resp = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, db);
    const tools = (resp!.result as { tools: Array<{ name: string; description: string; inputSchema: object }> }).tools;
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.inputSchema).toBe('object');
    }
  });
});

describe('dispatch: tools/call loom__list_boards', () => {
  it('returns seeded boards', async () => {
    const db = makeDb();
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'loom__list_boards', arguments: {} } },
      db,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const boards = JSON.parse(result.content[0].text) as Array<{ slug: string }>;
    expect(boards.map((b) => b.slug).sort()).toEqual(['personal', 'work']);
  });
});

describe('dispatch: tools/call loom__create_task', () => {
  it('creates and returns the task', async () => {
    const db = makeDb();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'loom__create_task',
          arguments: { title: 'Wire MCP', priority: 'high', board: 'personal' },
        },
      },
      db,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    const task = JSON.parse(result.content[0].text) as { id: number; title: string; priority: string; status: string };
    expect(task.title).toBe('Wire MCP');
    expect(task.priority).toBe('high');
    expect(task.status).toBe('backlog');
  });

  it('refuses unknown board', async () => {
    const db = makeDb();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'x', board: 'nope' } },
      },
      db,
    );
    const result = resp!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('board "nope" not found');
  });

  it('refuses missing title', async () => {
    const db = makeDb();
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'loom__create_task', arguments: {} } },
      db,
    );
    expect((resp!.result as { isError: boolean }).isError).toBe(true);
  });

  it('refuses invalid status enum', async () => {
    const db = makeDb();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 't', status: 'banana' } },
      },
      db,
    );
    const result = resp!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid status');
  });
});

describe('dispatch: tools/call loom__update_task', () => {
  it('patches allowed fields', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'x' } },
      },
      db,
    );
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'loom__update_task',
          arguments: { id: 1, patch: { status: 'in_progress', priority: 'high' } },
        },
      },
      db,
    );
    const updated = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    ) as { status: string; priority: string };
    expect(updated.status).toBe('in_progress');
    expect(updated.priority).toBe('high');
  });

  it('rejects disallowed field patches', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'x' } },
      },
      db,
    );
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'loom__update_task',
          arguments: { id: 1, patch: { archived_at: '2026-01-01' } },
        },
      },
      db,
    );
    const result = resp!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not patchable');
  });

  it('errors on empty patch', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'x' } },
      },
      db,
    );
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'loom__update_task', arguments: { id: 1, patch: {} } },
      },
      db,
    );
    expect((resp!.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('dispatch: tools/call loom__list_tasks', () => {
  it('filters by status', async () => {
    const db = makeDb();
    for (const status of ['backlog', 'todo', 'in_progress']) {
      await dispatch(
        {
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: { name: 'loom__create_task', arguments: { title: `t-${status}`, status } },
        },
        db,
      );
    }
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'loom__list_tasks', arguments: { status: 'todo' } },
      },
      db,
    );
    const rows = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    ) as Array<{ title: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('todo');
  });

  it('filters by board slug', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'p1', board: 'personal' } },
      },
      db,
    );
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'w1', board: 'work' } },
      },
      db,
    );
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: { name: 'loom__list_tasks', arguments: { board: 'work' } },
      },
      db,
    );
    const rows = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    ) as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(['w1']);
  });
});

describe('dispatch: tools/call loom__get_task', () => {
  it('returns task with labels and subtasks', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'x' } },
      },
      db,
    );
    db.prepare(`INSERT INTO labels (name) VALUES ('feature')`).run();
    db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (1, 1)`).run();
    db.prepare(`INSERT INTO subtasks (task_id, title) VALUES (1, 'do it')`).run();

    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'loom__get_task', arguments: { id: 1 } },
      },
      db,
    );
    const task = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    ) as { labels: Array<{ name: string }>; subtasks: Array<{ title: string }> };
    expect(task.labels.map((l) => l.name)).toEqual(['feature']);
    expect(task.subtasks.map((s) => s.title)).toEqual(['do it']);
  });

  it('errors on unknown id', async () => {
    const db = makeDb();
    const resp = await dispatch(
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'loom__get_task', arguments: { id: 999 } },
      },
      db,
    );
    expect((resp!.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('dispatch: tools/call loom__suggestions_today', () => {
  it('ranks in_progress + high priority first', async () => {
    const db = makeDb();
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'low', priority: 'low', status: 'backlog' } },
      },
      db,
    );
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: { name: 'loom__create_task', arguments: { title: 'hot', priority: 'high', status: 'in_progress' } },
      },
      db,
    );
    const resp = await dispatch(
      { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'loom__suggestions_today', arguments: {} } },
      db,
    );
    const rows = JSON.parse(
      (resp!.result as { content: Array<{ text: string }> }).content[0].text,
    ) as Array<{ title: string }>;
    expect(rows[0].title).toBe('hot');
  });
});

describe('dispatch: unknown method', () => {
  it('returns -32601 JSON-RPC error', async () => {
    const db = makeDb();
    const resp = await dispatch({ jsonrpc: '2.0', id: 99, method: 'totally/fake' }, db);
    expect(resp!.error?.code).toBe(-32601);
  });
});

describe('dispatch: notifications (no id)', () => {
  it('returns null (no response)', async () => {
    const db = makeDb();
    const resp = await dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' } as unknown as { jsonrpc: '2.0'; method: string },
      db,
    );
    expect(resp).toBeNull();
  });
});

describe('dispatch: ping', () => {
  it('returns empty result', async () => {
    const db = makeDb();
    const resp = await dispatch({ jsonrpc: '2.0', id: 100, method: 'ping' }, db);
    expect(resp!.result).toEqual({});
  });
});
