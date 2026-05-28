# Swrm MCP server

Hand-rolled JSON-RPC stdio MCP server exposing the PM kanban (tasks,
boards, attempts, comments) to any MCP client. Registered project-wide
via `.mcp.json` at repo root — Claude Code auto-loads it on session
start.

## Tools (`tools/list`)

- `swrm__list_boards`       — list all boards
- `swrm__list_tasks`        — filter by board / status / epic_id
- `swrm__get_task`          — single task with labels + subtasks
- `swrm__create_task`       — defaults to board=personal, status=backlog
- `swrm__update_task`       — patch allowlisted fields
- `swrm__list_epics`        — filter by board / status
- `swrm__suggestions_today` — top 10 urgent tasks (status × priority × due)
- `swrm__list_attempts`     — list attempts for a task
- `swrm__create_attempt`    — spawn worktree + branch; optional `auto_run`
- `swrm__update_attempt`    — patch status/summary/head_sha/refresh_diff
- `swrm__delete_attempt`    — removes worktree + branch + row

## Verifying the server stand-alone

```sh
# One-shot init smoke (exits 0 if stdio framing works)
npm run pm:mcp:smoke

# Manual REPL — paste JSON-RPC frames, watch responses on stdout:
npm run pm:mcp
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"swrm__list_boards","arguments":{}}}
^D
```

The integration test `__tests__/server.integration.test.ts` spawns the
server as a real subprocess and asserts initialize + tools/list both
parse cleanly off stdout. Run via `npx jest scripts/pm/mcp/`.

## Stdio framing rules (do not break)

- **stdout** is JSON-RPC frames only — one JSON object per line, no
  trailing whitespace, no banners. Anything else corrupts the client.
- **stderr** is for human logs — the server writes `[pm-mcp] ready
  (db=...)` on boot. Clients ignore stderr.
- Notifications (no `id`) get no response. Requests with an `id` get
  exactly one response with the same `id`.
- Unknown methods return JSON-RPC `-32601`. Parse errors return `-32700`.
