// scripts/pm/mcp/tools.ts — swrm__* MCP tool definitions + handlers.
//
// Each tool is callable via `tools/call` on the MCP server. The shape of
// `inputSchema` follows JSON Schema draft 7 — Claude Code uses it to
// validate arguments before dispatching. Handlers receive already-typed
// arguments (no runtime validation here; trust the schema).

import type Database from 'better-sqlite3';

import {
  createAttempt,
  deleteAttempt,
  listAttempts,
  updateAttempt,
} from '../api/attempts';
import { getSkillRuns, listSkills, runSkillNow } from '../api/skills';

type ToolContent = { type: 'text'; text: string };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    db: Database.Database,
  ) => ToolContent[] | Promise<ToolContent[]>;
}

function textResult(value: unknown): ToolContent[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function listBoards(_args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const rows = db
    .prepare(`SELECT id, slug, name, color, position FROM boards ORDER BY position, id`)
    .all();
  return textResult(rows);
}

function listTasks(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const where: string[] = ['archived_at IS NULL'];
  const params: Record<string, unknown> = {};

  if (typeof args.board === 'string' && args.board.length > 0) {
    where.push(`board_id = (SELECT id FROM boards WHERE slug = @board)`);
    params.board = args.board;
  }
  if (typeof args.board_id === 'number') {
    where.push(`board_id = @board_id`);
    params.board_id = args.board_id;
  }
  if (typeof args.status === 'string' && args.status.length > 0) {
    where.push(`status = @status`);
    params.status = args.status;
  }
  if (typeof args.epic_id === 'number') {
    where.push(`epic_id = @epic_id`);
    params.epic_id = args.epic_id;
  }

  const limit = typeof args.limit === 'number' ? Math.min(args.limit, 500) : 100;
  const sql = `
    SELECT id, board_id, epic_id, title, status, priority, effort_hours, due_date, position, created_at, updated_at
    FROM tasks
    WHERE ${where.join(' AND ')}
    ORDER BY position, id
    LIMIT ${limit}
  `;
  const rows = db.prepare(sql).all(params);
  return textResult(rows);
}

function getTask(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  const row = db
    .prepare(`SELECT * FROM tasks WHERE id = @id AND archived_at IS NULL`)
    .get({ id });
  if (!row) throw new Error(`task ${id} not found`);

  const labels = db
    .prepare(
      `SELECT l.id, l.name, l.color FROM labels l
       JOIN task_labels tl ON tl.label_id = l.id
       WHERE tl.task_id = @id`,
    )
    .all({ id });
  const subtasks = db
    .prepare(`SELECT id, title, done, position FROM subtasks WHERE task_id = @id ORDER BY position, id`)
    .all({ id });

  return textResult({ ...(row as object), labels, subtasks });
}

function createTask(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const title = args.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('title (non-empty string) is required');
  }
  const boardSlug = typeof args.board === 'string' ? args.board : 'personal';
  const board = db.prepare(`SELECT id FROM boards WHERE slug = @slug`).get({ slug: boardSlug }) as
    | { id: number }
    | undefined;
  if (!board) throw new Error(`board "${boardSlug}" not found`);

  const status = typeof args.status === 'string' ? args.status : 'backlog';
  const validStatus = new Set(['backlog', 'todo', 'in_progress', 'review', 'done']);
  if (!validStatus.has(status)) {
    throw new Error(`invalid status "${status}" (allowed: ${[...validStatus].join('|')})`);
  }

  const priority = typeof args.priority === 'string' ? args.priority : null;
  if (priority !== null && !['high', 'medium', 'low'].includes(priority)) {
    throw new Error(`invalid priority "${priority}" (allowed: high|medium|low)`);
  }

  const description = typeof args.description === 'string' ? args.description : null;
  const epicId = typeof args.epic_id === 'number' ? args.epic_id : null;
  const effortHours = typeof args.effort_hours === 'number' ? args.effort_hours : null;
  const dueDate = typeof args.due_date === 'string' ? args.due_date : null;

  const result = db
    .prepare(
      `INSERT INTO tasks (board_id, epic_id, title, description, status, priority, effort_hours, due_date)
       VALUES (@board_id, @epic_id, @title, @description, @status, @priority, @effort_hours, @due_date)`,
    )
    .run({
      board_id: board.id,
      epic_id: epicId,
      title: title.trim(),
      description,
      status,
      priority,
      effort_hours: effortHours,
      due_date: dueDate,
    });

  const created = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.lastInsertRowid);
  return textResult(created);
}

function updateTask(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  const patch = (args.patch as Record<string, unknown>) ?? {};

  const allowed: Record<string, true> = {
    title: true,
    description: true,
    status: true,
    priority: true,
    effort_hours: true,
    due_date: true,
    blockers: true,
    epic_id: true,
    position: true,
  };

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed[key]) throw new Error(`field "${key}" not patchable via MCP`);
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (sets.length === 0) throw new Error('patch is empty');
  sets.push(`updated_at = datetime('now')`);

  const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = @id AND archived_at IS NULL`;
  const result = db.prepare(sql).run(params);
  if (result.changes === 0) throw new Error(`task ${id} not found or already archived`);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  return textResult(updated);
}

function listEpics(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (typeof args.board === 'string') {
    where.push(`board_id = (SELECT id FROM boards WHERE slug = @board)`);
    params.board = args.board;
  }
  if (typeof args.status === 'string') {
    where.push(`status = @status`);
    params.status = args.status;
  }
  const sql = `
    SELECT id, board_id, title, description, status, target_date, position
    FROM epics
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY position, id
  `;
  return textResult(db.prepare(sql).all(params));
}

async function createAttemptTool(
  args: Record<string, unknown>,
  db: Database.Database,
): Promise<ToolContent[]> {
  const taskId = args.task_id;
  if (typeof taskId !== 'number') throw new Error('task_id (number) is required');
  const agentName = typeof args.agent_name === 'string' ? args.agent_name : undefined;
  const baseRef = typeof args.base_ref === 'string' ? args.base_ref : undefined;
  const repoRoot = typeof args.repo_root === 'string' ? args.repo_root : undefined;
  const autoRun = args.auto_run === true;
  const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
  const attempt = await createAttempt(db, taskId, {
    agent_name: agentName,
    base_ref: baseRef,
    repo_root: repoRoot,
    auto_run: autoRun,
    prompt,
  });
  return textResult(attempt);
}

function listAttemptsTool(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const taskId = args.task_id;
  if (typeof taskId !== 'number') throw new Error('task_id (number) is required');
  return textResult(listAttempts(db, taskId));
}

async function updateAttemptTool(
  args: Record<string, unknown>,
  db: Database.Database,
): Promise<ToolContent[]> {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  const patch = (args.patch as Record<string, unknown>) ?? {};
  const updated = await updateAttempt(db, id, {
    status: typeof patch.status === 'string' ? (patch.status as 'running' | 'completed' | 'failed' | 'abandoned') : undefined,
    summary: typeof patch.summary === 'string' ? patch.summary : undefined,
    head_sha: typeof patch.head_sha === 'string' ? patch.head_sha : undefined,
    refresh_diff: patch.refresh_diff === true,
  });
  return textResult(updated);
}

async function deleteAttemptTool(
  args: Record<string, unknown>,
  db: Database.Database,
): Promise<ToolContent[]> {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  const ok = await deleteAttempt(db, id);
  if (!ok) throw new Error(`attempt ${id} not found`);
  return textResult({ deleted: id });
}

function suggestionsToday(_args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  // Mirrors the heuristic in scripts/pm/api/suggestions.ts: prefer
  // in_progress > todo > backlog, then high priority, then earlier due_date.
  const rows = db
    .prepare(
      `SELECT id, board_id, title, status, priority, due_date,
              CASE status WHEN 'in_progress' THEN 3 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 1 ELSE 0 END
              + CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END
              AS score
       FROM tasks
       WHERE archived_at IS NULL AND status IN ('backlog','todo','in_progress')
       ORDER BY score DESC, due_date IS NULL, due_date ASC, id ASC
       LIMIT 10`,
    )
    .all();
  return textResult(rows);
}

function listSkillsTool(_args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  return textResult(listSkills(db));
}

function getSkillRunsTool(args: Record<string, unknown>, db: Database.Database): ToolContent[] {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  return textResult(getSkillRuns(db, id, limit));
}

async function runSkillTool(args: Record<string, unknown>, db: Database.Database): Promise<ToolContent[]> {
  const id = args.id;
  if (typeof id !== 'number') throw new Error('id (number) is required');
  return textResult(await runSkillNow(db, id));
}

export const TOOLS: ToolDef[] = [
  {
    name: 'swrm__list_boards',
    description: 'List all kanban boards (slug, name, color).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: listBoards,
  },
  {
    name: 'swrm__list_tasks',
    description: 'List tasks. Filter by board slug, status, or epic_id. Defaults to non-archived, limit 100.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Board slug (e.g. "personal").' },
        board_id: { type: 'number' },
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] },
        epic_id: { type: 'number' },
        limit: { type: 'number', maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
    handler: listTasks,
  },
  {
    name: 'swrm__get_task',
    description: 'Fetch a single task by id, including its labels and subtasks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: getTask,
  },
  {
    name: 'swrm__create_task',
    description: 'Create a new task. Defaults: board=personal, status=backlog.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        board: { type: 'string', default: 'personal' },
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'], default: 'backlog' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        description: { type: 'string' },
        epic_id: { type: 'number' },
        effort_hours: { type: 'number' },
        due_date: { type: 'string', description: 'ISO YYYY-MM-DD' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: createTask,
  },
  {
    name: 'swrm__update_task',
    description: 'Patch a task by id. Allowed fields: title, description, status, priority, effort_hours, due_date, blockers, epic_id, position.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        patch: { type: 'object' },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    handler: updateTask,
  },
  {
    name: 'swrm__list_epics',
    description: 'List epics. Filter by board slug or status.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'archived'] },
      },
      additionalProperties: false,
    },
    handler: listEpics,
  },
  {
    name: 'swrm__suggestions_today',
    description: 'Top 10 urgent tasks scored by status × priority × due-date proximity. Mirrors /api/suggestions/today.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: suggestionsToday,
  },
  {
    name: 'swrm__list_attempts',
    description: 'List all attempts (agent runs in git worktrees) for a task, ordered by attempt_number.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'number' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: listAttemptsTool,
  },
  {
    name: 'swrm__create_attempt',
    description: 'Spawn a new attempt: creates a fresh git worktree in repo_root on a new branch (attempt/task-<id>-<n>) off base_ref (default main). When auto_run=true, immediately forks the configured agent binary (claude/codex/gemini) in the worktree + streams its stdout into chat_messages. Multi-repo: pass repo_root to spawn against a project other than this one. Returns the attempt row.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        agent_name: {
          type: 'string',
          description: 'lowercase identifier (claude-code | codex | gemini | manual)',
          default: 'claude-code',
        },
        base_ref: { type: 'string', default: 'main' },
        repo_root: { type: 'string', description: 'absolute path to the target repo; defaults to server cwd' },
        auto_run: { type: 'boolean', description: 'fork the agent subprocess in the worktree on spawn (default false)', default: false },
        prompt: { type: 'string', description: 'prompt forwarded to the agent when auto_run=true' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    handler: createAttemptTool,
  },
  {
    name: 'swrm__update_attempt',
    description: 'Patch an attempt. patch.refresh_diff=true recomputes diff_stats + head_sha from the worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        patch: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['running', 'completed', 'failed', 'abandoned'] },
            summary: { type: 'string' },
            head_sha: { type: 'string' },
            refresh_diff: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    handler: updateAttemptTool,
  },
  {
    name: 'swrm__delete_attempt',
    description: 'Remove an attempt: deletes the worktree, deletes the branch, deletes the row. Idempotent on missing worktree.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: deleteAttemptTool,
  },
  {
    name: 'swrm__list_skills',
    description: 'List all Skill Cards (Skill Mode): scheduled automations with type (agent|command), frequency, side_effects, enabled state, last_status, last_run, next_due.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: listSkillsTool,
  },
  {
    name: 'swrm__run_skill',
    description: 'Run a skill now, bypassing its schedule (respects the single-flight lock). Returns {status:"ok"|"error"} or {skipped:true} if already running.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: runSkillTool,
  },
  {
    name: 'swrm__get_skill_runs',
    description: 'Return recent run history (agent_runs rows) for a skill, newest first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, limit: { type: 'number', default: 20 } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: getSkillRunsTool,
  },
];

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  db: Database.Database,
): Promise<ToolContent[]> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return await tool.handler(args, db);
}
