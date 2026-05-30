# Native "Start work" (branch-per-story) — design (Slice C2)

_Date: 2026-05-30 · Status: approved (autonomous build)_

## Context
D3 pushes "the current branch" + opens a PR, but the native flow has no per-story branch, so there's no
story↔branch↔PR link (and D4 PR→done can't know which card to close). C2 fills that gap: **"Start work"**
on a card creates + checks out the story's branch (`Story.branchName()` → `sc-<id>/<slug>`, already in
SwrmCore). After C2, D3's push/PR is naturally per-story and D4 has a card to map. Local git only (macOS).

## Decisions
1. **Per-card "Start work" context-menu action** (macOS). Creates + checks out `story.branchName()` from
   current HEAD; if the branch already exists, just switches to it. Local — no remote writes.
2. **macOS-only.** Branch creation uses the git CLI (`Process`), like C/D3. On iOS the menu item isn't shown.
3. Reuse `Story.branchName()` (public, SwrmCore) — no new naming logic.
4. Operates in the git repo containing the current stories dir (`BoardModel.storiesDirectory`).

## Components / files
### SwrmCore
- **`GitBrancher.swift`** (`#if os(macOS)`) — `struct GitBrancher { func createOrSwitch(branch: String, in directory: URL) throws }`:
  `git -C <dir> switch -c <branch>`; if that fails (branch exists), fall back to `git -C <dir> switch <branch>`;
  still failing → `GitBranchError.failed(stderr)`. (git 2.23+ `switch`; macOS git qualifies.)

### SwrmUI
- **`BranchModel.swift`** (`@MainActor ObservableObject`) — `@Published lastResult: String?`
  (e.g. `"On sc-1/wire-up…"` or an error). Injected `brancher: (String, URL) throws -> Void` seam
  (default = `GitBrancher().createOrSwitch` on macOS, no-op-throw on iOS). `startWork(story: Story, dir: URL?)`:
  guard dir; `let b = story.branchName()`; `try brancher(b, dir)` → `lastResult = "On \(b)"`; throw → error message.

### Apps/Shared
- **`BoardView`** — add `onStartWork: ((Story) -> Void)?`; `StoryCardView` gets a `.contextMenu { Button("Start work", systemImage: "arrow.branch") { onStartWork?(story) } }` (the item shown only when `onStartWork != nil`).
- **`ContentView`** — owns `@StateObject branch`; passes `onStartWork: { story in branch.startWork(story: story, dir: model.storiesDirectory) }` to `BoardView` **only on macOS** (`#if os(macOS)`; iOS passes nil → no menu item). A brief confirmation via the existing alert pattern or a transient label (reuse `branch.lastResult`).

## Data flow
```
right-click card → "Start work" → BranchModel.startWork(story, dir)
  guard dir → else lastResult = error
  branch = story.branchName()            // sc-<id>/<slug>
  GitBrancher.createOrSwitch(branch, dir)
     git switch -c <branch>      ok → done
        fails (exists)           → git switch <branch>  ok → done ; fail → throw
  lastResult = "On <branch>"  (error → message)
```

## Error & edge
| Condition | Behavior |
|---|---|
| No repo / not a git dir | `git switch` fails → `lastResult` error ("Couldn't create branch"). |
| Branch already exists | Falls back to plain switch → success ("On <branch>"). |
| Dirty working tree blocks switch | git refuses → error surfaced (stderr); no state change. |
| iOS | No menu item (onStartWork nil); `BranchModel` compiles via the iOS no-op brancher. |

## Testing
- **`GitBrancherTests`** (macOS): temp `git init` repo + a commit; `createOrSwitch("sc-1/x")` → current branch
  is `sc-1/x`; calling again (exists) → no throw, still on `sc-1/x`.
- **`BranchModelTests`** (SwrmUI): injected brancher seam → `startWork` calls it with `story.branchName()` +
  the dir, sets `lastResult`; nil dir → error + brancher not called; brancher throws → error `lastResult`.
- **UI**: build mac+iOS (iOS excludes the menu item); manual — right-click a card → "Start work" → `git branch`
  shows the new `sc-id/slug` and HEAD is on it.

## Out of scope (later)
PR→done (D4, now unblocked), deleting/renaming branches, branch picker, committing the move onto the new
branch automatically, GitLab.
