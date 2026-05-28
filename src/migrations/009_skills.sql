-- Swarm Skills (Skill Mode) — config/schedule layer over the existing
-- background-agent system. A Skill Card (*.skill.md) is synced into this
-- table; the orchestrator queries it for what is due. Run history reuses
-- the existing agent_runs table (see 010_agent_runs_skill_link.sql) rather
-- than a parallel table.

CREATE TABLE IF NOT EXISTS skills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,                       -- slug, unique per project
  project         TEXT    NOT NULL,                       -- swrm board/project this belongs to
  type            TEXT    NOT NULL,                       -- 'agent' | 'command'
  enabled         INTEGER NOT NULL DEFAULT 1,             -- pause switch (0/1)
  frequency       TEXT    NOT NULL,                       -- @hourly | @daily[ HH:MM] | Nh | Nm | weekly:<dow>
  side_effects    TEXT    NOT NULL,                       -- 'read-only' | 'writes' | 'external'
  timeout         INTEGER NOT NULL DEFAULT 600,           -- seconds; run killed past this
  agent           TEXT,                                   -- agent type only: claude | codex | gemini
  needs_worktree  INTEGER NOT NULL DEFAULT 0,             -- agent type only; 1 if the run edits code
  mcp             TEXT    NOT NULL DEFAULT '[]',          -- JSON array of allowed MCP servers
  command         TEXT,                                   -- command type only: shell entrypoint
  prompt_ref      TEXT,                                   -- optional external prompt file (agent type)
  on_findings     TEXT    NOT NULL DEFAULT 'append',      -- 'append' (v1) | 'create-task' (phase 2)
  last_run        TEXT,                                   -- ISO; written by orchestrator
  next_due        TEXT,                                   -- ISO; computed
  last_status     TEXT    NOT NULL DEFAULT 'idle',        -- idle | running | ok | error | skipped
  file_path       TEXT,                                   -- source *.skill.md path
  body_hash       TEXT,                                   -- hash of the card body (skip unchanged on sync)
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, project)
);
CREATE INDEX IF NOT EXISTS idx_skills_due ON skills(enabled, next_due);
