# Native git-backed moves — design (Slice C)

_Date: 2026-05-29 · Status: approved (autonomous — user said "go to slice C and don't stop")_

## Context
Slice B made the native board editable: a drag rewrites the `.md` `state:` line. Slice C makes each
such move a **clean git commit** — the architecture doc's contract: *"moving a card = one front-matter
field edit = one clean git commit."* This is the **C1 Commit** rung of the Event Modeling blueprint
(`StoryStateChanged` → `ChangeCommitted(sha)`; from here on, git IS the event store / audit log).

Builds on B: `StoryWriter` (surgical write), `BoardModel.moveStory` (optimistic + echo-suppress).

## Decisions
1. **Auto-commit on move.** After `StoryWriter.setState` succeeds, stage + commit *only that file* with
   message `"<id>: <old> → <new>"` (e.g. `sc-3: backlog → started`).
2. **`GitCommitter` shells out to `git` via `Process` → macOS only.** iOS has no git binary / `Process`,
   so the whole git path is `#if os(macOS)`. On iOS a move still writes the file (B), just no commit.
3. **Best-effort.** Commit failure (not-a-repo, git error, "nothing to commit") does NOT revert the move
   and does NOT change `LoadState`. The `.md` file is the source of truth; the commit is a bonus, logged
   and swallowed. (No repo → silently skipped — opening a non-git folder still works.)
4. **Async / off-main.** The commit runs in a detached `Task` so it never blocks the drag/UI.
5. **Scope = commit-on-move only.** Branch convention (`sc-<id>/<slug>` start-work, C2), PR→done, and CI
   overlay (slice D) are out of scope.

## Components / files
### SwrmCore (macOS-only, unit-tested)
- **`GitCommitter.swift`** (new, wrapped in `#if os(macOS)`) —
  `func commit(file: URL, message: String) throws -> String` (returns the new HEAD sha):
  - `git -C <file dir> rev-parse --show-toplevel` → repo root (throw `GitError.notARepo` if not a repo).
  - `git -C <repo> add -- <file>` then `git -C <repo> commit -m <message> -- <file>` (path-scoped → commits
    only this file even if other changes are staged). Tolerate "nothing to commit" as a no-op.
  - Returns `git -C <repo> rev-parse HEAD`. Non-zero git exit → `GitError.failed(stderr)`.
  - Private `run(_ args:, inDir:)` helper: `Process` on `/usr/bin/git`, capture stdout/stderr.

### SwrmCore change to B
- **`StoryWriter.setState(...)`** now returns the written file `URL` (`@discardableResult`) so the caller
  can pass it to `GitCommitter`. Purely additive — existing tests ignore the return.

### SwrmUI
- **`BoardModel.moveStory`** — after the successful `setState`, on macOS fire a detached commit:
  `Task.detached { try? GitCommitter().commit(file: fileURL, message: "\(id): \(old) → \(new)") }`.
  Guarded `#if os(macOS)`. No change to the optimistic/echo-suppress/revert logic from B.

## Data flow
```
moveStory(id → Y)
  └─ optimistic move + suppressNextReload (slice B)
  └─ fileURL = try StoryWriter.setState(id, Y, dir)         ← B, now returns the URL
       throw ─▶ revert + .error (B)
       ok    ─▶ #if os(macOS): Task.detached { GitCommitter().commit(fileURL, "id: X → Y") }
                  notARepo / git error / nothing-to-commit ─▶ swallowed (move stays saved)
                  success ─▶ one clean commit on HEAD (sha)
```

## Error & edge
| Condition | Behavior |
|---|---|
| Stories dir not in a git repo | `notARepo` → swallowed; move saved, no commit. |
| git not installed / `Process` fails | `failed` → swallowed; move saved. |
| "nothing to commit" (file already committed) | Treated as no-op success. |
| iOS | No commit path compiled in; move writes the file only. |
| Commit races the watcher | `git add/commit` doesn't modify the `.md` → no extra watcher event, no echo. |

## Testing
- **`GitCommitterTests`** (SwrmCore, macOS): in a temp dir, `git init` + config a test identity + an initial
  commit; modify the file; `commit(file:message:)` returns a sha and `git log -1 --format=%s` shows the
  message; a non-repo temp dir throws `.notARepo`; committing an unchanged file is a no-op (no throw).
- **`StoryWriterTests`**: add an assertion that `setState` returns the URL of the written file.
- **`BoardModelTests`** (macOS): a move inside a `git init`'d stories dir eventually produces a commit
  (poll `git log` with a timeout for the detached task); a move in a non-git dir still succeeds (no throw,
  card moved). Keep existing move tests green.
- **Manual**: drag a card in a git-backed `.swrm/stories` dir → `git log` shows `"<id>: old → new"`.

## Out of scope (later slices)
Branch convention / start-work (C2), PR open + PR→done, CI overlay, providers/auth (slice D), undo,
commit-status UI, configurable commit messages.
