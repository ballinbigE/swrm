// swrm/src/skills/executor.ts — run a Skill Card.
//
// type: command  -> runCommandSkill (this file): spawn the entrypoint.
// type: agent    -> runAgentSkill (agent.ts): spawn an AI agent.
//
// Each executor records one agent_runs row and appends a dated entry to the
// card's ## Runs log. It does NOT touch the skills row's last_status/next_due
// — that's the orchestrator's job (US-007), so "run now" and the scheduler
// share one executor without fighting over scheduling state.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import type Database from 'better-sqlite3';

import { appendRunToCard, formatWhen, recordRun } from './runlog';

export interface RunnableCommandSkill {
  id: number;
  name: string;
  command: string | null;
  timeout: number;
  file_path: string | null;
}

export interface RunResult {
  status: 'ok' | 'error';
  agent_run_id: number;
  summary: string;
  durationMs: number;
}

export interface RunOpts {
  cwd?: string;
  now?: Date;
}

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
}

export async function runCommandSkill(
  db: Database.Database,
  skill: RunnableCommandSkill,
  opts: RunOpts = {},
): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const command = skill.command ?? '';
  const start = Date.now();

  const outcome = await new Promise<SpawnOutcome>((resolve) => {
    let out = '';
    let err = '';
    // `command` is operator-authored Skill Card content (akin to a crontab
    // line or an npm script), not interpolated request input — shell is
    // required to run arbitrary entrypoints. Timeout bounds runaway runs.
    const child = spawn(command, {
      shell: true,
      cwd,
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
