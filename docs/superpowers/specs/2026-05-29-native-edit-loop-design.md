# Native edit loop — design (Slice B)

_Date: 2026-05-29 · Status: approved design, pre-plan_

## Context
The native macOS/iOS app (slice A, shipped v0.2.0) renders a **read-only** board from
`.swrm/stories/*.md` with live file-watch. Slice B makes it **editable** in the smallest real way:
drag a card between columns to change its `state`, written straight back to the `.md` file. This is
the **B1 MoveStory** rung of the Event Modeling blueprint (`MoveStory(id,state)` → `StoryStateChanged`
→ rewrite front-matter). Field editing, create/delete, and within-column reordering are later slices.

Builds directly on slice A: `BoardModel` (`@MainActor ObservableObject`, `LoadState`), `StoryStore`
(load-only), `StoryParser` (`parse`/`serialize`), `FolderWatcher` (debounced reload), `BoardView`.

## Decisions locked (from brainstorming)
1. **Scope:** drag-to-move **between columns** only (changes `state`). No field edits, no
   create/delete, no within-column reorder — the moved card keeps its `rank`.
2. **Approach A:** surgical one-line front-matter write (not full re-serialize), optimistic in-memory
   move, watcher echo-suppressed.
3. **Why surgical:** `StoryParser.serialize` emits a *canonical* form (fixed key order, drops unmodeled
   keys, normalizes the body) — lossy for a real user file. Slice B changes one field → touch one line.

## Architecture / components

### SwrmCore (pure Foundation, unit-tested)
- **`StoryWriter.swift`** (new) — `struct StoryWriter { func setState(storyID: String, to: WorkflowState, in directory: URL) throws }`.
  - Resolve the file: try `<directory>/<storyID>.md`; if absent, scan `*.md` for the one whose parsed
    `id` equals `storyID`.
  - Read the text, operate on the front-matter block (between the opening `---\n` and the closing
    `\n---`), **replace only the `state:` line's value** (or insert a `state:` line if missing),
    leaving every other byte — body, comments, unknown keys, ordering — untouched. Write back (atomic).
  - Throws `StoryWriteError.notFound` if no file matches, and surfaces FS write errors.

### SwrmUI
- **`BoardModel.moveStory(_ id: String, to newState: WorkflowState)`** (new):
  - No-op if the story is already in `newState`.
  - **Optimistic:** rebuild the in-memory `Board` with that story's `state = newState`, publish
    `.loaded(board)`. Keep the prior board for rollback.
  - Set `suppressNextReload = true`; `try writer.setState(storyID: id, to: newState, in: currentStoriesDir)`.
  - On throw: restore the prior board, `state = .error("Couldn't save move")`, clear the flag.
  - The `FolderWatcher` callback checks `suppressNextReload`: if set, clear it and **skip one reload**
    (the optimistic board already matches disk); otherwise reload normally.
- **`BoardView`** — cards become `.draggable` carrying the story id via a small `Transferable`
  (`StoryDragID`); each column is a `.dropDestination(for: StoryDragID.self)` that calls
  `model.moveStory(id, to: column.state)`. (Transferable drag/drop APIs are iOS 16 / macOS 13 — match targets.)

### Data flow
```
drag card (id) off col X ─▶ drop on col Y ─▶ BoardView → model.moveStory(id, to: Y)
  └─ already Y? no-op
  └─ optimistic: board' = move(id→Y); publish .loaded(board'); keep prior
  └─ suppressNextReload = true
  └─ try StoryWriter.setState(id, Y, dir)
        success ─▶ disk matches board'  ─▶ FolderWatcher fires ─▶ callback sees flag ─▶ clear + skip reload
        throw   ─▶ board = prior; state = .error; clear flag
external edit later ─▶ FolderWatcher fires ─▶ flag unset ─▶ normal reload
```

## Error & edge handling
| Condition | Behavior |
|---|---|
| Write throws (perms / file moved) | Revert optimistic move; `state = .error("Couldn't save move")`. |
| Story id has no matching `.md` | `StoryWriteError.notFound` → revert + error. |
| Drop on the same column | No-op; no write. |
| Moved card's rank | Unchanged → sorts by existing `rank` in the new column (no reorder in B). |
| Echo race (external edit during suppress window) | Worst case one skipped/extra reload; board re-derives correctly next tick. Surgical write only touches the `state:` line → no corruption. |

## Testing
- **`StoryWriterTests`** (SwrmCore): `setState` changes only the `state:` line — assert all other
  front-matter lines + body + an **unknown front-matter key** are byte-identical; `state:`-missing case
  inserts it; unknown/missing-file id throws `.notFound`; `parse` after write reports the new state.
- **`BoardModelTests`** (SwrmUI, extend existing temp-dir pattern): `moveStory` moves the card
  optimistically (now in the target column); persists (a fresh `StoryStore.load` of the dir shows the
  new state); same-column = no-op; write-failure path reverts to the prior board + `.error`
  (simulate via a deleted/unwritable dir); echo-suppress skips exactly one reload then resumes.
- **Drag UI**: not unit-testable (SwiftUI) → build mac+iOS + manual: drag a `native/sample/stories`
  card to a new column, confirm the card moves, the `.md` `state:` flipped on disk, and live-watch
  doesn't double-fire/flicker.

## Out of scope (later slices)
Field editing (title/labels/type/epic), create/delete stories, within-column drag-reorder (rank),
git commit-on-move (slice C), providers/CI (slice D).
