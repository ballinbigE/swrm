-- Loom preferences: per-board workflow (ordered column set).
-- color already exists on boards (001_init, default #d97757). This adds
-- a JSON array of status keys defining that board's kanban columns + order.
-- Default = the canonical five so existing boards behave unchanged.

ALTER TABLE boards ADD COLUMN workflow TEXT NOT NULL DEFAULT '["backlog","todo","in_progress","review","done"]';
