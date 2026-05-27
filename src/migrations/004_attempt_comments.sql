-- US-VK-005 — Inline diff comments anchored to an attempt.
-- Rep clicks a diff line → comment → save. Comments also fan-out to
-- chat_messages so the re-prompt loop has the feedback in context.

CREATE TABLE IF NOT EXISTS attempt_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id      INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  file_path       TEXT,                                   -- path relative to repo root, e.g. 'src/foo.ts'
  line_number     INTEGER,                                 -- 1-indexed line in the diff (NULL = file-level)
  diff_line       TEXT,                                    -- raw diff line text (the +/-/ line being commented on)
  body            TEXT    NOT NULL,                        -- rep's comment
  resolved        INTEGER NOT NULL DEFAULT 0,              -- 0/1 boolean
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempt_comments_attempt ON attempt_comments(attempt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempt_comments_open    ON attempt_comments(resolved, created_at);
