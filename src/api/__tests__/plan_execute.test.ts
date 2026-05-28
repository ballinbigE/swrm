// Tests for POST /api/plan/execute.
//
// Strategy:
//   - slugify + priorityForStory + prdToTaskRows are pure → unit-tested
//     directly (no Anthropic, no http).
//   - 400 (empty idea) + 503 (no API key) go through a real http.Server with
//     the unstubbed handler (those branches short-circuit before any
//     Anthropic call: 400 before planFromIdea, 503 because the real
//     planFromIdea throws MissingApiKeyError with no key set).
//   - happy path (write files + insert tasks) goes through the server with a
//     stubbed `_planFn` so no live Anthropic call is needed. auto_spawn is
//     left false to avoid needing a real git repo (createAttempt is covered
//     by attempts.test.ts).

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import type { Prd } from '../../plan';
import {
  planExecuteHandler,
  prdToTaskRows,
  priorityForStory,
  slugify,
} from '../plan_execute';

const execFileAsync = promisify(execFile);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of [
    '001_init.sql',
    '003_attempts.sql',
    '004_attempt_comments.sql',
    '005_chat_message_scope.sql',
    '006_external_md_ref.sql',
    '007_attempts_repo_root.sql',
  ]) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8');
    (db as { exec(s: string): void }).exec(sql);
  }
  db.prepare(`INSERT INTO boards (slug, name) VALUES ('personal', 'Personal')`).run();
  return db;
}

function fakePrd(): Prd {
  return {
    project: 'swrm',
    branchName: 'main',
    description: 'Build the thing.',
    userStories: [
      {
        id: 'US-PLAN-A',
        title: 'Add Foo Bar! Baz',
        description: 'First story.',
        acceptanceCriteria: ['Do A', 'Typecheck clean'],
        priority: 1,
        passes: false,
        notes: '',
      },
      {
        id: 'US-PLAN-B',
        title: 'Persist it',
        description: 'Second story.',
        acceptanceCriteria: ['Do B', 'Typecheck clean'],
        priority: 2,
        passes: false,
        notes: '',
      },
      {
        id: 'US-PLAN-C',
        title: 'Polish',
        description: 'Third story.',
        acceptanceCriteria: ['Do C'],
        priority: 5,
        passes: false,
        notes: '',
      },
    ],
  };
}

// Spin a one-shot server, fire one request, return { status, json }.
async function callHandler(
  body: unknown,
  db: Database.Database,
  planFn?: (idea: string) => Promise<Prd>,
): Promise<{ status: number; json: any }> {
  const server = http.createServer(async (req, res) => {
    const handled = planFn
      ? await planExecuteHandler(req, res, db, planFn as never)
      : await planExecuteHandler(req, res, db);
    if (!handled) {
      res.writeHead(404);
      res.end('not handled');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };

  try {
    const payload = JSON.stringify(body);
    const resp = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, path: '/api/plan/execute', method: 'POST' },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    return { status: resp.status, json: resp.text ? JSON.parse(resp.text) : null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('slugify', () => {
  it('lowercases + replaces non-alphanumeric runs with dashes', () => {
    expect(slugify('Add Foo Bar! Baz')).toBe('add-foo-bar-baz');
  });
  it('trims leading/trailing dashes', () => {
    expect(slugify('  --Hello-- ')).toBe('hello');
  });
  it('caps at 40 chars (and never ends on a dash)', () => {
    const out = slugify('a'.repeat(60));
    expect(out.length).toBe(40);
    const out2 = slugify('word '.repeat(20)); // many dashes once cut
    expect(out2.length).toBeLessThanOrEqual(40);
    expect(out2.endsWith('-')).toBe(false);
  });
  it('falls back to "plan" on empty/non-alphanumeric input', () => {
    expect(slugify('')).toBe('plan');
    expect(slugify('!!!')).toBe('plan');
  });
});

describe('priorityForStory', () => {
  it('maps <=1 → high, ==2 → medium, else → low', () => {
    expect(priorityForStory(0)).toBe('high');
    expect(priorityForStory(1)).toBe('high');
    expect(priorityForStory(2)).toBe('medium');
    expect(priorityForStory(3)).toBe('low');
    expect(priorityForStory(99)).toBe('low');
  });
});

describe('prdToTaskRows', () => {
  it('builds one row per story with mapped priority + external_md_ref', () => {
    const rows = prdToTaskRows(fakePrd(), 7, 'add-foo-bar-baz');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      board_id: 7,
      title: 'Add Foo Bar! Baz',
      description: 'First story.',
      status: 'backlog',
      priority: 'high',
      external_md_ref: 'prd-add-foo-bar-baz.json#US-PLAN-A',
    });
    expect(rows[1].priority).toBe('medium');
    expect(rows[2].priority).toBe('low');
    expect(rows[2].external_md_ref).toBe('prd-add-foo-bar-baz.json#US-PLAN-C');
  });
});

describe('planExecuteHandler', () => {
  let db: Database.Database;
  let prevKey: string | undefined;
  let prevCwd: string;
  let tmpCwd: string;

  beforeEach(() => {
    db = makeDb();
    prevKey = process.env.ANTHROPIC_API_KEY;
    prevCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-test-'));
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    db.close();
    process.chdir(prevCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it('400s on empty idea', async () => {
    const { status, json } = await callHandler({ idea: '   ' }, db);
    expect(status).toBe(400);
    expect(json.error).toMatch(/idea \(non-empty string\) is required/);
  });

  it('400s on missing idea field', async () => {
    const { status } = await callHandler({}, db);
    expect(status).toBe(400);
  });

  it('503s when ANTHROPIC_API_KEY is unset (real planFromIdea)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { status, json } = await callHandler({ idea: 'build a thing' }, db);
    expect(status).toBe(503);
    expect(json.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('happy path: writes prd json+md, inserts tasks, returns ids', async () => {
    const { status, json } = await callHandler(
      { idea: 'build a thing', auto_spawn: false },
      db,
      async () => fakePrd(),
    );

    expect(status).toBe(200);
    // process.cwd() resolves macOS /var → /private/var symlinks; compare on realpath.
    const realCwd = fs.realpathSync(tmpCwd);
    expect(json.prd_path).toBe(path.resolve(realCwd, 'prd-add-foo-bar-baz.json'));
    expect(json.md_path).toBe(path.resolve(realCwd, 'prd-add-foo-bar-baz.md'));
    expect(json.attempt_id).toBeNull();
    expect(json.task_ids).toHaveLength(3);

    // Files written
    expect(fs.existsSync(json.prd_path)).toBe(true);
    expect(fs.existsSync(json.md_path)).toBe(true);
    const writtenJson = JSON.parse(fs.readFileSync(json.prd_path, 'utf8'));
    expect(writtenJson.userStories).toHaveLength(3);
    const writtenMd = fs.readFileSync(json.md_path, 'utf8');
    expect(writtenMd).toContain('# Add Foo Bar! Baz');
    expect(writtenMd).toContain('### US-PLAN-A — Add Foo Bar! Baz');

    // Rows inserted with mapped priority + external_md_ref
    const rows = db
      .prepare(`SELECT id, title, status, priority, external_md_ref FROM tasks ORDER BY id`)
      .all() as Array<{ id: number; title: string; status: string; priority: string; external_md_ref: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(json.task_ids);
    expect(rows[0].status).toBe('backlog');
    expect(rows[0].priority).toBe('high');
    expect(rows[1].priority).toBe('medium');
    expect(rows[2].priority).toBe('low');
    expect(rows[0].external_md_ref).toBe('prd-add-foo-bar-baz.json#US-PLAN-A');
  });

  it('happy path with auto_spawn spawns an attempt on the first task', async () => {
    // Real git repo so createAttempt can build a worktree.
    const repoRoot = path.join(tmpCwd, 'repo');
    fs.mkdirSync(repoRoot);
    process.env.PM_WORKTREE_ROOT = path.join(tmpCwd, 'wts');
    // auto_run fires runAgentInWorktree fire-and-forget. Point the
    // claude-code binary at `true` (instant clean exit) so the test doesn't
    // launch a real LLM CLI in the background.
    process.env.PM_AGENT_BINARY_CLAUDE_CODE = 'true';
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README'), 'hi\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

    // createAttempt uses process.cwd() as repo_root when none supplied → chdir into repo.
    process.chdir(repoRoot);
    try {
      const { status, json } = await callHandler(
        { idea: 'build a thing', auto_spawn: true },
        db,
        async () => fakePrd(),
      );
      expect(status).toBe(200);
      expect(typeof json.attempt_id).toBe('number');

      const attempt = db.prepare(`SELECT task_id FROM attempts WHERE id = ?`).get(json.attempt_id) as
        | { task_id: number }
        | undefined;
      expect(attempt?.task_id).toBe(json.task_ids[0]);

      // The fire-and-forget agent subprocess updates attempts.status on exit.
      // Wait for it to settle so it doesn't write to a closed DB in afterEach.
      for (let i = 0; i < 100; i += 1) {
        const row = db.prepare(`SELECT status FROM attempts WHERE id = ?`).get(json.attempt_id) as
          | { status: string }
          | undefined;
        if (row && row.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      process.chdir(tmpCwd);
      delete process.env.PM_WORKTREE_ROOT;
      delete process.env.PM_AGENT_BINARY_CLAUDE_CODE;
    }
  });
});
