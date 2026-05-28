<p align="center">
  <img src="./assets/logo-wordmark.svg" alt="Swrm" width="280" />
</p>

<p align="center">
  <strong>MCP-native kanban for parallel coding agents. Markdown-friendly. Localhost-first. <code>npx swrm</code>.</strong>
</p>

<!-- TODO: 30-second screencast GIF — see docs/screencast-script.md -->

## What

Swrm is a localhost web app that gives you a kanban board, a per-task workspace, and an agent runtime — all in one tool. Spawn parallel Claude Code / Codex / Gemini attempts on a task, each in its own git worktree. Comment on diffs. Re-prompt with feedback. Merge when ready. Drive the whole thing from inside Claude Code via the built-in MCP server.

## Why

Layered on top of three convictions:

1. **The PM tool should know about the agent.** Every kanban built for humans assumes the human types the work. Swrm assumes Claude does it, and the rep reviews.
2. **MCP-first.** Claude should read and write the board the same way it reads files. Swrm ships a JSON-RPC MCP server so `mcp__swrm__*` tools appear in Claude Code automatically.
3. **Localhost beats SaaS.** Your code, your DB, your machine. Apache 2.0, no telemetry, no account.

## Install

Straight from GitHub (no npm account needed):

```sh
npx github:ballinbigE/swrm
# clones, builds, opens http://localhost:5173
```

Or, once published to npm:

```sh
npx swrm
# opens http://localhost:5173 — daily command is `swrm`
```

That's it. SQLite DB lives at `.swrm/swrm.db` (gitignored). Press `s` in any workspace to spawn an attempt.

## Why Swrm (vs the alternatives)

| | Swrm | vibe-kanban | Conductor | Crystal | Backlog.md |
|---|---|---|---|---|---|
| OSS | ✅ Apache 2.0 | ✅ Apache 2.0 (sunset Apr 2026) | ❌ closed | ❌ closed | ✅ MIT |
| Stack | Node + SQLite | Rust + Postgres | macOS-native | Electron | Node + markdown |
| Cross-platform | ✅ | ✅ | macOS only | ✅ | ✅ |
| MCP server (first-party) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Git worktree per attempt | ✅ | ✅ | ✅ | ✅ | ❌ |
| Markdown ↔ SQLite bidir sync | ✅ | ❌ | ❌ | ❌ | md-only |
| AI Project Breakdown (idea → PRD → stories) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Inline diff comments → reprompt | ✅ | ❌ | partial | ❌ | ❌ |
| Multi-repo attempts | ✅ | ❌ | ❌ | ❌ | ❌ |
| Pluggable preview pane (iOS sim, web, etc.) | ✅ | partial | ❌ | ❌ | ❌ |

## Architecture

```
swrm/
├── src/
│   ├── cli.ts                # bin entry
│   ├── server.ts             # http server + route table
│   ├── db.ts + migrations/   # SQLite (better-sqlite3)
│   ├── api/                  # boards, tasks, attempts, comments, diff, plan
│   ├── lib/                  # worktree, agent_runner, http, log
│   ├── mcp/                  # stdio JSON-RPC server (mcp__swrm__* tools)
│   ├── views/                # server-rendered HTML (kanban, workspace, tasks)
│   ├── sync_md.ts            # markdown ↔ SQLite reconciler
│   └── plan.ts               # AI Project Breakdown
├── plugins/
│   └── preview-ios/          # iOS simulator screenshot preview (optional)
└── tests/                    # jest
```

## Quickstart

1. `npx swrm` — boots dashboard at http://localhost:5173 (installed command is `swrm`).
2. On the home page, type an idea ("Build a dark-mode toggle for my app").
3. Click **Generate & Execute** — Claude breaks it into 3-12 user stories, you preview, save as `prd-<slug>.json`.
4. Go to **Tasks** → click any story → **+ Attempt**.
5. Spawn opens a fresh git worktree at `~/Library/Application Support/swrm/worktrees/task-N-M` on branch `attempt/task-N-M`.
6. Open the worktree in your editor (workspace has an Open-in-VSCode button). Make changes.
7. Diff updates in the workspace within 5s. Click any diff line to comment.
8. Press `r` to bundle comments into a reprompt; press `m` to merge into `main`.

## Plugins

Swrm ships with no preview plugins out of the box. Add one in `.swrmrc.json`:

```json
{
  "plugins": ["@swrm/preview-ios"]
}
```

Then `npm install @swrm/preview-ios`. The plugin matches tasks whose worktree contains an `ios/` directory and renders a live `xcrun simctl io booted screenshot` PNG in the workspace right pane.

Write your own — see the `PreviewPlugin` interface in `src/plugins/preview.d.ts`.

## MCP integration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "swrm": {
      "command": "npx",
      "args": ["swrm", "mcp"]
    }
  }
}
```

Claude Code will auto-load 11 `mcp__swrm__*` tools — `list_tasks`, `create_task`, `create_attempt`, etc. Now Claude can drive the board itself.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Roadmap

Tracked in [GitHub Issues](https://github.com/ballinbigE/swrm/issues). Notable upcoming:

- Cross-attempt diff compare (A vs B)
- WebSocket bidirectional MCP transport
- Built-in preview plugins for web (Playwright) + Storybook
- Cloud sync (opt-in, hosted tier — OSS core stays whole)

## Maintenance

See [MAINTENANCE.md](./MAINTENANCE.md) — single maintainer, evenings + weekends, best-effort. PRs welcome, please open an issue first for non-trivial changes.

## License

Apache 2.0. See [LICENSE](./LICENSE).
