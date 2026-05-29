CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#d97757',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_position ON projects(position);
ALTER TABLE boards ADD COLUMN project_id INTEGER REFERENCES projects(id);
INSERT INTO projects (slug, name, root_path, position) VALUES ('default', 'Default', '__SWRM_ROOT__', 0);
UPDATE boards SET project_id = (SELECT id FROM projects WHERE slug='default') WHERE project_id IS NULL;
