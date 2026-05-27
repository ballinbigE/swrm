-- US-VK-007 — Scope chat_messages to a task + optional attempt so
-- rep comments on attempt #3 of task A don't bleed into task A's
-- attempt #1 conversation (or worse, task B's workspace).
--
-- Backfill: legacy rows stay with NULL task_id (treated as global /
-- pre-scoping) and are excluded from per-workspace queries going forward.

ALTER TABLE chat_messages ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN attempt_id INTEGER REFERENCES attempts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_task_attempt ON chat_messages(task_id, attempt_id, created_at);
