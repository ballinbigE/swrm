-- Link a background-agent run to the Skill Card that triggered it, and add
-- timing + findings columns. Skill runs reuse agent_runs rather than a
-- parallel skill_runs table: a skill run is an agent_runs row with skill_id
-- set. All columns are nullable so legacy agent_runs inserts (bug_fix,
-- prioritize_backlog) are unaffected.

ALTER TABLE agent_runs ADD COLUMN skill_id       INTEGER REFERENCES skills(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN finished_at    TEXT;
ALTER TABLE agent_runs ADD COLUMN findings_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_agent_runs_skill ON agent_runs(skill_id, created_at);
