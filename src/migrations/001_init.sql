-- US-001 — Personal AI PM System initial schema.
-- 9 user-facing tables + _migrations tracking.
-- FKs on; deletes never cascade across the Epic→Task or Task→Subtask edges
-- (those are handled in app code as soft-detach / soft-archive).

-- PRAGMAs (journal_mode, foreign_keys) are set in scripts/pm/db.ts at
-- connection time — must be set OUTSIDE any transaction.

-- ── 1. boards ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#d97757',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_boards_position ON boards(position);

-- ── 2. epics ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS epics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id      INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  title         TEXT    NOT NULL,
  description   TEXT,
  color         TEXT    NOT NULL DEFAULT '#f6c545',
  status        TEXT    NOT NULL DEFAULT 'open',  -- open | done | archived
  target_date   TEXT,   -- ISO YYYY-MM-DD
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_epics_board_status ON epics(board_id, status);

-- ── 3. tasks ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id            INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  epic_id             INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  title               TEXT    NOT NULL,
  description         TEXT,
  status              TEXT    NOT NULL DEFAULT 'backlog',  -- backlog | todo | in_progress | review | done
  priority            TEXT,   -- high | medium | low
  effort_hours        REAL,
  due_date            TEXT,   -- ISO YYYY-MM-DD
  blockers            TEXT,
  position            INTEGER NOT NULL DEFAULT 0,
  auto_categorized    INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  samples_count       INTEGER NOT NULL DEFAULT 1,  -- for agent-filed dedupe
  archived_at         TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_board_status ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_epic         ON tasks(epic_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date     ON tasks(due_date);

-- ── 4. subtasks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subtasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);

-- ── 5. labels ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS labels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#34d399',
  board_id    INTEGER REFERENCES boards(id) ON DELETE CASCADE,  -- NULL = global label
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, board_id)
);
CREATE INDEX IF NOT EXISTS idx_labels_board ON labels(board_id);

-- ── 6. task_labels (join) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_labels (
  task_id   INTEGER NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
  label_id  INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);

-- ── 7. attachments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  original_filename  TEXT    NOT NULL,
  stored_path        TEXT    NOT NULL,
  mime_type          TEXT    NOT NULL,
  size_bytes         INTEGER NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

-- ── 8. chat_messages ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  role            TEXT    NOT NULL,  -- user | assistant | system
  content         TEXT    NOT NULL,
  agent_run_id    INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

-- ── 9. agent_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name     TEXT    NOT NULL,  -- 'bug_fix' | 'perf_monitor' | 'self_audit' | 'chat' | 'auto_categorize' | ...
  action         TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'ok',  -- ok | error | skipped
  task_id        INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent   ON agent_runs(agent_name, created_at);
