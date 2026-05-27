-- US-VK-002 — Per-task agent attempts with git worktree isolation.
-- Inspired by BloopAI/vibe-kanban's attempt model: each issue (task) can
-- have N attempts, each attempt = own branch + worktree dir so parallel
-- agents on the same task don't stomp each other.
--
-- Distinct from agent_runs (which is for cron-style background agents
-- like bug_fix / perf_monitor — one row per run, no git isolation).

CREATE TABLE IF NOT EXISTS attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_number  INTEGER NOT NULL,                          -- 1-indexed within task
  branch_name     TEXT    NOT NULL UNIQUE,                   -- e.g. 'attempt/task-42-1'
  worktree_path   TEXT    NOT NULL UNIQUE,                   -- absolute path on disk
  agent_name      TEXT    NOT NULL DEFAULT 'claude-code',    -- claude-code | codex | gemini | manual
  status          TEXT    NOT NULL DEFAULT 'running',        -- running | completed | failed | abandoned
  summary         TEXT,                                       -- rep or LLM-generated
  diff_stats      TEXT,                                       -- JSON: {files: N, insertions: I, deletions: D}
  base_sha        TEXT,                                       -- commit SHA the attempt branched from
  head_sha        TEXT,                                       -- commit SHA of attempt tip (latest)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  UNIQUE(task_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_attempts_task    ON attempts(task_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_attempts_status  ON attempts(status, created_at);
