# todo — build + install latest swrm, dogfood on nugget-expo

## Goal
Build/install the existing swrm (Node localhost kanban) and run it against the
`nugget-expo` project as the beta-test target. Lowest-blast-radius path to a
working, cross-device-testable swrm now. The native macOS/iOS redesign is a
SEPARATE, larger initiative (see "Out of scope" below) — pending the core-stack
decision + its own spec.

## Plan (checkable)
- [x] 1. Build swrm fresh: `npm run build` (produces latest post-rebrand `dist/`).
- [x] 2. Verify build: `npm run typecheck` clean + `dist/cli.js` runs `--version` → 0.1.0.
- [x] 3. Install bin: `npm link` (reversible) so `swrm` resolves on PATH.
- [x] 4. Run against nugget-expo WITHOUT polluting its git tree — DB path kept
        OUTSIDE the repo via `SWRM_DB_PATH=~/.swrm/nugget.db`.
- [x] 5. Boot dashboard. NOTE: :5173 was occupied by a pre-existing swrm instance
        (PID 66424, left untouched), so booted on `SWRM_PORT=5174`.
- [x] 6. Verify: HTTP 200 on http://localhost:5174, title "Swrm", board renders,
        no fatal logs. nugget-expo git tree confirmed clean (zero pollution).
- [x] 7. Document results below + capture lessons in `tasks/lessons.md`.

## Decisions to confirm before I start
- **A. nugget-expo cleanliness:** keep swrm's SQLite DB OUTSIDE nugget-expo
  (`~/.swrm/nugget.db`) so its git tree stays clean. Alternative: DB inside
  `nugget-expo/.swrm/` + add to its `.gitignore` (touches nugget repo). I
  recommend OUTSIDE (minimal impact). Confirm.
- **B. "latest version":** I read this as the current `main` HEAD of this repo,
  rebuilt fresh. If "this uptodate?" meant something else, tell me what "this" is.
- **C. seed data:** boot empty (you add stories), or also run
  `swrm plan --idea "..."` to generate a starter PRD board for nugget? (plan
  needs `ANTHROPIC_API_KEY`.) Default: boot empty.

## Out of scope (separate spec)
- New native macOS + iOS apps; shared Swrm Core; GitHub/GitLab provider + auth;
  CI overlay; Markdown-as-source-of-truth redesign. Brainstorm not finished.

## Review
Done + verified. swrm v0.1.0 (this repo `main` HEAD) built clean, typecheck clean,
installed via `npm link`. Running against nugget-expo:

- URL: http://localhost:5174 (NOT 5173 — that port held a pre-existing swrm
  instance, PID 66424, left running untouched per minimal-impact).
- Server log: `seeded 3 board(s) + 6 label(s)` · `sync-md inserted 2` ·
  `DB v7 · 2 tasks`.
- curl: HTTP 200, `<title>Swrm — describe what you want to build</title>`.
- DB: `~/.swrm/nugget.db` (outside the nugget-expo repo).
- nugget-expo `git status`: clean. No `.swrm/` leaked into the repo.

Behavior diff: before = no swrm serving nugget; after = swrm board for nugget-expo
on :5174, real markdown synced in, nugget git untouched.

To stop: kill the background process (bash id baegi92xv) or `lsof -ti:5174 | xargs kill`.
To uninstall bin: `npm unlink -g swrm` (or `npm rm -g swrm`).

