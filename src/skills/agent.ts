// swrm/src/skills/agent.ts — agent executor for type:agent Skill Cards.
//
// Reuses the agent_runner spawn pattern (spawn, array args, no shell) but is
// decoupled from the attempt model: a skill run has no worktree by default and
// writes no chat_messages. The card body is the agent prompt; the MCP allowlist
// is exposed via the SWRM_SKILL_MCP env var so only listed servers are in scope.
//
// Worktree handling: this executor never creates a worktree. The orchestrator
// (US-007) decides cwd — passing a worktree path only when needs_worktree is
// set — so the "no worktree by default" invariant is structural here.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import type Database from 'better-sqlite3';

import type { RunOpts, RunResult } from './executor';
import { appendRunToCard, formatWhen, recordRun } from './runlog';
import { parseSkillCard } from './sync';

const DEFAULT_AGENT_BINARY: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

export interface RunnableAgentSkill {
  id: number;
  name: string;
  agent: string | null;
  mcp: string[];
  timeout: number;
  file_path: string | null;
  needs_worktree: boolean;
}

export interface AgentRunOpts extends RunOpts {
  /** Override the resolved binary (tests point this at echo/sh). */
  binary?: string;
  /** Extra args before the prompt. */
  args?: string[];
  /** Override the prompt (else the card body is used). */
  prompt?: string;
}

function resolveAgentBinary(agent: string | null, override?: string): string | null {
  if (override) return override;
  if (!agent) return null;
  const key = agent.toUpperCase().replace(/-/g, '_');
  return process.env[`SWRM_SKILL_AGENT_BINARY_${key}`] ?? DEFAULT_AGENT_BINARY[agent] ?? null;
}

function readBody(skill: RunnableAgentSkill): string {
  if (skill.file_path && fs.existsSync(skill.file_path)) {
    return parseSkillCard(fs.readFileSync(skill.file_path, 'utf8')).body.trim();
  }
  return '';
}

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
}

export async function runAgentSkill(
  db: Database.Database,
  skill: RunnableAgentSkill,
  opts: AgentRunOpts = {},
): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const binary = resolveAgentBinary(skill.agent, opts.binary);
  const start = Date.now();

  if (!binary) {
    const summary = `no binary resolved for agent '${skill.agent}'`;
    const id = recordRun(db, {
      skill_id: skill.id,
      agent_name: skill.name,
      action: 'skill-run',
      status: 'error',
      notes: summary,
      finished_at: new Date().toISOString(),
    });
    return { status: 'error', agent_run_id: id, summary, durationMs: 0 };
  }

  const prompt = opts.prompt ?? readBody(skill);
  const args = [...(opts.args ?? []), ...(prompt ? [prompt] : [])];

  const outcome = await new Promise<SpawnOutcome>((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, SWRM_SKILL_MCP: JSON.stringify(skill.mcp) },
      timeout: skill.timeout * 1000,
      killSignal: 'SIGKILL',
    });
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: Error) => resolve({ code: null, signal: null, out, err: `${err}${e.message}` }));
    child.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });

  const durationMs = Date.now() - start;
  const killed = outcome.signal != null;
  const status: 'ok' | 'error' = !killed && outcome.code === 0 ? 'ok' : 'error';

  let summary: string;
  if (killed) {
    summary = `timed out after ${skill.timeout}s`;
  } else if (status === 'ok') {
    summary = (outcome.out.trim() || '(no output)').slice(0, 500);
  } else {
    summary = `exit ${outcome.code}: ${(outcome.err.trim() || outcome.out.trim() || '(no output)').slice(0, 400)}`;
  }

  const agentRunId = recordRun(db, {
    skill_id: skill.id,
    agent_name: skill.name,
    action: 'skill-run',
    status,
    notes: summary,
    finished_at: new Date().toISOString(),
  });

  if (skill.file_path && fs.existsSync(skill.file_path)) {
    appendRunToCard(skill.file_path, {
      when: formatWhen(now),
      status,
      durationMs,
      summary: summary.split('\n')[0].slice(0, 200),
    });
  }

  return { status, agent_run_id: agentRunId, summary, durationMs };
}
