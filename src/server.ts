// scripts/pm/server.ts — one-command boot for the Personal AI PM System.
// `npm run pm` → migrate → seed-if-empty → start http server on $DASHBOARD_PORT
// (default 5173) → print boot log.
//
// Per US-003 of tasks/prd-personal-ai-pm-system.md. Replaces the standalone
// pm_dashboard.ts entrypoint (which is now an importable handler — kept
// callable via `npm run dashboard` for backward-compat until US-011 lands).

import * as http from 'node:http';
import * as path from 'node:path';

import { getDb, runPendingMigrations } from './db';
import { gcOrphanWorktrees } from './lib/worktree';
import { seedDefaults } from './seed';
import { syncProjectMarkdown } from './sync_md';
import { boardsApiHandler } from './api/boards';
import { tasksApiHandler } from './api/tasks';
import { subtasksApiHandler } from './api/subtasks';
import { labelsApiHandler } from './api/labels';
import { epicsApiHandler } from './api/epics';
import { prioritizeBacklogHandler } from './api/agents/prioritize_backlog';
import { bugFixIngestHandler } from './api/agents/bug_fix';
import { suggestionsApiHandler } from './api/suggestions';
import { attemptsApiHandler } from './api/attempts';
import { attemptDiffHandler } from './api/diff';
import { attemptCommentsHandler } from './api/attempt_comments';
import { previewHandler } from './api/preview';
import { workspaceStreamHandler } from './api/workspace_stream';
import { planApiHandler } from './api/plan';
import { planExecuteHandler } from './api/plan_execute';
import { workspaceHandler } from './views/workspace';
import { tasksListHandler } from './views/tasks_list';
import { boardHandler } from './views/board';
import { homeHandler } from './views/home';
import { faviconHandler } from './views/favicon';
import { whatsNewHandler } from './views/whats_new';
import { settingsHandler } from './views/settings';
import { versionApiHandler } from './api/version';
import { boardPrefsHandler } from './api/board_prefs';
import { projectsApiHandler } from './api/projects';
import { skillsApiHandler } from './api/skills';
import { skillsViewHandler } from './views/skills';
import { syncSkillsDir } from './skills/sync';
import { startOrchestrator } from './skills/orchestrator';
// Legacy markdown-mirror kanban dropped in swrm (was tied to the original host repo
// tasks/backlog.md format). The SQLite-backed /tasks view is the canonical
// kanban now; home '/' serves the idea-input form (M8).

const PORT = Number(process.env.SWRM_PORT ?? process.env.DASHBOARD_PORT ?? 5173);
const ROOT = process.cwd();

// shipped.md mirror lives under the consumer's CWD; let them point elsewhere
// via env. Default = .swrm/shipped.md so it doesn't collide with the consumer's
// own tasks/ directory.
if (!process.env.PM_SHIPPED_MD_PATH) {
  process.env.PM_SHIPPED_MD_PATH = path.join(ROOT, '.swrm', 'shipped.md');
}

function bootBanner(dbVersion: number, taskCount: number): void {
  // eslint-disable-next-line no-console
  console.log(`[swrm] http://localhost:${PORT} · DB v${dbVersion} · ${taskCount} task${taskCount === 1 ? '' : 's'}`);
}

async function main(): Promise<void> {
  // 1. migrate
  const db = getDb();
  const migrate = runPendingMigrations(db);
  if (migrate.applied.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[swrm] applied ${migrate.applied.length} migration(s)`);
  }

  // 1b. replace the sentinel root_path in the default project (idempotent)
  db.prepare(`UPDATE projects SET root_path = ? WHERE root_path = '__SWRM_ROOT__'`).run(ROOT);

  // 2. seed-if-empty
  const seed = seedDefaults(db);
  if (!seed.skipped) {
    // eslint-disable-next-line no-console
    console.log(`[swrm] seeded ${seed.boards_inserted} board(s) + ${seed.labels_inserted} label(s)`);
  }

  // 3. orphan-worktree GC. Run once per distinct repo_root so each repo
  // gets its own `git worktree remove` cycle (multi-repo support).
  try {
    const rows = db.prepare(`SELECT worktree_path, repo_root FROM attempts`).all() as Array<{
      worktree_path: string;
      repo_root: string;
    }>;
    const tracked = rows.map((r) => r.worktree_path);
    const repos = new Set<string>([ROOT, ...rows.map((r) => r.repo_root).filter((r) => r && r.length > 0)]);
    let totalRemoved = 0;
    for (const repo of repos) {
      const gc = await gcOrphanWorktrees(tracked, { repoRoot: repo });
      totalRemoved += gc.removed.length;
    }
    if (totalRemoved > 0) {
      // eslint-disable-next-line no-console
      console.log(`[swrm] gc removed ${totalRemoved} orphan worktree(s) across ${repos.size} repo(s)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[swrm] gc skipped:', (err as Error).message);
  }

  // 3b. markdown ↔ SQLite reconcile — loop over all projects (non-fatal on parse error).
  // The 'default' project's root_path == ROOT so legacy behaviour is preserved.
  try {
    const projects = db.prepare(`SELECT slug, root_path FROM projects`).all() as Array<{slug: string; root_path: string}>;
    let inserted = 0, archived = 0;
    for (const p of projects) {
      const r = syncProjectMarkdown(db, p);
      inserted += r.inserted;
      archived += r.archived;
    }
    if (inserted > 0 || archived > 0) console.log(`[swrm] sync-md inserted ${inserted} · archived ${archived}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[swrm] sync-md skipped:', (err as Error).message);
  }

  // 3c. Skill Mode — sync *.skill.md cards, then start the in-process
  // orchestrator. Skills dir is configurable; defaults outside the repo
  // (D-1) so it doesn't pollute the target's git tree.
  try {
    const os = require('node:os') as typeof import('node:os');
    const skillsDir = process.env.SWRM_SKILLS_DIR ?? path.join(os.homedir(), '.swrm', 'skills');
    const sk = syncSkillsDir(db, skillsDir);
    if (sk.inserted > 0 || sk.updated > 0) {
      // eslint-disable-next-line no-console
      console.log(`[swrm] skills synced: +${sk.inserted} ~${sk.updated} (=${sk.unchanged})`);
    }
    // Pass syncDir so each tick re-syncs the cards — new/edited *.skill.md
    // appear without a server restart.
    startOrchestrator(db, {
      cwdFor: (skill) => {
        const p = db.prepare(`SELECT root_path FROM projects WHERE slug = ?`).get(skill.project) as {root_path: string} | undefined;
        return p?.root_path ?? ROOT;
      },
      syncDir: skillsDir,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[swrm] skill mode skipped:', (err as Error).message);
  }

  // 4. count tasks for the boot banner
  const taskCount = (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL`).get() as { n: number }).n;

  // 4. boot http server. /api/* routes go first (US-004+), then the
  // markdown-mirror kanban handler at /, then 404.
  const server = http.createServer(async (req, res) => {
    if (faviconHandler(req, res)) return;
    if (versionApiHandler(req, res)) return;
    if (await projectsApiHandler(req, res, db)) return;
    if (whatsNewHandler(req, res)) return;
    if (boardsApiHandler(req, res, db)) return;
    // Nested-under-task routes first — subtasks, labels, attempts all mount
    // at /api/tasks/:id/{subtasks,labels,attempts} which would collide with
    // the tasks handler's /api/tasks/:id$ matcher if it ran first.
    if (await subtasksApiHandler(req, res, db)) return;
    if (await labelsApiHandler(req, res, db)) return;
    if (workspaceStreamHandler(req, res)) return;
    if (await planExecuteHandler(req, res, db)) return;
    if (await planApiHandler(req, res)) return;
    if (await previewHandler(req, res, db)) return;
    if (await attemptDiffHandler(req, res, db)) return;
    if (await attemptCommentsHandler(req, res, db)) return;
    if (await attemptsApiHandler(req, res, db)) return;
    if (await workspaceHandler(req, res, db)) return;
    if (await boardPrefsHandler(req, res, db)) return;
    if (await skillsApiHandler(req, res, db)) return;
    if (await tasksListHandler(req, res, db)) return;
    if (await boardHandler(req, res, db)) return;
    if (await skillsViewHandler(req, res, db)) return;
    if (await settingsHandler(req, res, db)) return;
    if (await tasksApiHandler(req, res, db)) return;
    if (await epicsApiHandler(req, res, db)) return;
    if (await prioritizeBacklogHandler(req, res, db)) return;
    if (await bugFixIngestHandler(req, res, db)) return;
    if (suggestionsApiHandler(req, res, db)) return;
    // Home '/' serves the idea-input form (M8 — vibecoderplanner pattern).
    if (await homeHandler(req, res, db)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(`[swrm] port ${PORT} already in use — another dashboard running? Try: lsof -ti:${PORT} | xargs kill`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error('[swrm] server error:', err);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    bootBanner(migrate.current, taskCount);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[swrm] fatal:', err);
  process.exit(1);
});
