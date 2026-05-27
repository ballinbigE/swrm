// scripts/pm/lib/agent_runner.ts — fork an agent subprocess in an
// attempt's worktree, stream stdout/stderr into chat_messages, flip
// attempt status when the subprocess exits.
//
// Per US-VK-R-003. Agent binary defaults are:
//   claude-code → 'claude'
//   codex       → 'codex'
//   gemini      → 'gemini'
//   manual      → no-op (rep drives by hand)
// Override per agent via PM_AGENT_BINARY_<AGENT_UPPER> env var (tests
// use this to point at `sh -c` so they don't need a real LLM CLI).
//
// Security: spawn (not exec), array args — no shell, no injection.
// agent_name was already validated by createAttempt (lowercase alphanum
// + dashes, max 30 chars) so the env-var lookup key is safe.

import { spawn } from 'node:child_process';

import type Database from 'better-sqlite3';

import { broadcast } from '../api/workspace_stream';

export interface RunOptions {
  /** Prompt text the agent receives as its first arg / stdin. */
  prompt?: string;
  /** Override the binary for this agent_name (else env var, else default). */
  binary?: string;
  /** Extra args before the prompt. */
  args?: string[];
  /**
   * If true, prompt arrives on stdin instead of as an argv element.
   * Useful for agents that accept piped-in queries.
   */
  promptOnStdin?: boolean;
}

export interface RunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  linesCaptured: number;
}

const DEFAULT_BINARY: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

function envBinaryFor(agentName: string): string | undefined {
  const safe = agentName.toUpperCase().replace(/-/g, '_');
  return process.env[`PM_AGENT_BINARY_${safe}`];
}

function resolveBinary(agentName: string, override?: string): string | null {
  if (override) return override;
  const fromEnv = envBinaryFor(agentName);
  if (fromEnv) return fromEnv;
  if (agentName === 'manual') return null;
  return DEFAULT_BINARY[agentName] ?? null;
}

/**
 * Fork the configured agent in the attempt's worktree. Returns a Promise
 * resolving when the subprocess exits. Streams stdout/stderr into
 * chat_messages with role='assistant', scoped to the attempt's task and
 * attempt ids. Updates attempts.status on exit.
 *
 * Caller is responsible for catching errors if they want fire-and-forget.
 */
export function runAgentInWorktree(
  db: Database.Database,
  attempt: {
    id: number;
    task_id: number;
    agent_name: string;
    worktree_path: string;
  },
  options: RunOptions = {},
): Promise<RunResult> {
  const binary = resolveBinary(attempt.agent_name, options.binary);
  if (!binary) {
    return Promise.resolve({ exitCode: 0, signal: null, linesCaptured: 0 });
  }

  const prompt = options.prompt ?? '';
  const args = [
    ...(options.args ?? []),
    ...(!options.promptOnStdin && prompt ? [prompt] : []),
  ];

  const insertMsg = db.prepare(
    `INSERT INTO chat_messages (role, content, task_id, attempt_id)
     VALUES (?, ?, ?, ?)`,
  );
  const updateStatus = db.prepare(
    `UPDATE attempts
       SET status = ?, completed_at = datetime('now')
     WHERE id = ?`,
  );

  return new Promise<RunResult>((resolve) => {
    const child = spawn(binary, args, {
      cwd: attempt.worktree_path,
      env: { ...process.env },
    });

    let linesCaptured = 0;
    let stdoutTail = '';
    let stderrTail = '';

    const emit = (role: 'assistant' | 'system', text: string) => {
      if (text.length === 0) return;
      const r = insertMsg.run(role, text, attempt.task_id, attempt.id);
      linesCaptured += 1;
      broadcast(attempt.task_id, 'chat-message-appended', {
        attempt_id: attempt.id,
        message: { id: r.lastInsertRowid as number, role, content: text, created_at: new Date().toISOString() },
      });
    };

    const drain = (tailKey: 'stdoutTail' | 'stderrTail', chunk: string, role: 'assistant' | 'system') => {
      const combined = (tailKey === 'stdoutTail' ? stdoutTail : stderrTail) + chunk;
      const parts = combined.split('\n');
      const lastPartial = parts.pop() ?? '';
      for (const line of parts) emit(role, line);
      if (tailKey === 'stdoutTail') stdoutTail = lastPartial;
      else stderrTail = lastPartial;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => drain('stdoutTail', chunk, 'assistant'));
    child.stderr.on('data', (chunk: string) => drain('stderrTail', chunk, 'system'));

    if (options.promptOnStdin && prompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    } else if (!options.promptOnStdin) {
      child.stdin.end();
    }

    child.on('error', (err) => {
      emit('system', `[agent_runner] spawn error: ${err.message}`);
      updateStatus.run('failed', attempt.id);
      resolve({ exitCode: -1, signal: null, linesCaptured });
    });

    child.on('exit', (code, signal) => {
      // Flush any partial tail (no trailing newline).
      if (stdoutTail.length > 0) emit('assistant', stdoutTail);
      if (stderrTail.length > 0) emit('system', stderrTail);
      const finalStatus = code === 0 && signal === null ? 'completed' : 'failed';
      updateStatus.run(finalStatus, attempt.id);
      resolve({ exitCode: code ?? -1, signal, linesCaptured });
    });
  });
}
