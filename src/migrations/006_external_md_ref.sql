-- US-VK-R-005 — bridge tasks/*.md ↔ SQLite tasks table.
-- external_md_ref pins a SQLite task back to a markdown source line so
-- the sync_md reconciler can detect which rows came from where + GC
-- when the md line disappears.

ALTER TABLE tasks ADD COLUMN external_md_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_external_md_ref ON tasks(external_md_ref);
