// swrm/src/skills/types.ts — Skill Card domain types.
//
// A Skill Card is the new config/schedule layer over the existing background
// agent system (agent_runs + src/api/agents/*). The vocabularies are exported
// as const arrays so the DB layer, sync, and UI share one source of truth.

export const SKILL_TYPES = ['agent', 'command'] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

export const SIDE_EFFECTS = ['read-only', 'writes', 'external'] as const;
export type SideEffects = (typeof SIDE_EFFECTS)[number];

export const SKILL_STATUSES = ['idle', 'running', 'ok', 'error', 'skipped'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export interface Skill {
  id: number;
  name: string;
  project: string;
  type: SkillType;
  enabled: boolean;
  frequency: string;
  side_effects: SideEffects;
  timeout: number;
  /** agent type only: claude | codex | gemini */
  agent: string | null;
  needs_worktree: boolean;
  /** MCP servers allowed for an agent run (parsed from JSON text column). */
  mcp: string[];
  /** command type only: shell entrypoint run in the project cwd. */
  command: string | null;
  /** optional path to an external prompt file (agent type). */
  prompt_ref: string | null;
  on_findings: string;
  last_run: string | null;
  next_due: string | null;
  last_status: SkillStatus;
  file_path: string | null;
  body_hash: string | null;
  updated_at: string;
}
