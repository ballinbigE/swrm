-- US-023 — pluggable LLM driver + chat_messages indexing.
-- The chat_messages table itself ships in 001_init.sql; this migration adds
-- the (role, created_at) composite index needed for the chat UI's
-- per-role lookups (e.g. "last 20 user messages", "system prompts ordered").
--
-- The 001 migration already covers idx_chat_messages_created (single-col by
-- created_at) — kept for the Daily Log feed; this one is additive.

CREATE INDEX IF NOT EXISTS idx_chat_messages_role_created
  ON chat_messages(role, created_at);
