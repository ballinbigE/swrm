-- US-VK-R-008 — Multi-repo attempts.
-- Each attempt remembers which repo it spawned in so the dashboard
-- becomes a cross-project workbench (claude-skills, fintech-adventures,
-- not only the primary repo).
--
-- Backfill: existing rows pre-VK-R-008 default to the empty string —
-- callers (mergeAttempt, deleteAttempt) fall back to process.cwd()
-- when repo_root is empty so legacy data keeps working.

ALTER TABLE attempts ADD COLUMN repo_root TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_attempts_repo_root ON attempts(repo_root);
