# Native PR→done — design (Slice D4)

_Date: 2026-05-30 · Status: approved (autonomous; closes the native A–D loop → v1.0.0)_

## Context
C2 gave every story a branch (`Story.branchName()`). D4 closes the loop: for a card, ask GitHub whether
its branch's PR has merged, and if so move the card to **done** — reusing B's write-back (rewrites `state:`)
and C's commit-on-move. This is the final Event Modeling rung (`PRMerged` → story `state: done`).

## Decisions (recommended trigger, confirmed)
1. **Per-card "Mark done if merged"** context-menu action (macOS) — explicit, one API call. (No board-wide
   N-call sweep; that's a later optimization.)
2. **Merged check** = `GET /repos/{o}/{r}/pulls?state=all&head={owner}:{branch}` → merged iff any returned PR
   has `merged_at != null`.
3. On merged → `BoardModel.moveStory(id, to: .done)` (B writes `state: done`; C commits it on macOS). On
   not-merged / error → a friendly message, no change.
4. macOS-only (owner/repo via `GitRepoReader`, like D2/D3). Uses the D1 token.

## Components / files
### SwrmCore
- **`GitHubClient.isPullMerged(owner:repo:head:token:) async throws -> Bool`** — `head` = `"<owner>:<branch>"`;
  GET pulls filtered by head; decode `[{ merged_at: String? }]`; return `contains { merged_at != nil }`.
  Same injectable `fetch` → unit-tested.

### SwrmUI
- **`PRDoneModel.swift`** (`@MainActor ObservableObject`) — `@Published lastResult: String?`; injected
  `store`/`client`/`resolveRepo`. `enum MergeResult { case merged, notMerged, error(String) }`.
  `checkMerged(story:dir:) async -> MergeResult`: guard dir + token + repo → build `head=owner:branchName` →
  `client.isPullMerged` → set `lastResult` ("Marked done" / "PR not merged yet" / message) + return result.
  `clear()`.

### Apps/Shared
- **`BoardView`** — add `onCheckDone: ((Story) -> Void)?`; the card context menu gains a "Mark done if merged"
  `Button` (shown when non-nil), beside "Start work".
- **`ContentView`** — owns `@StateObject prDone`; `checkDoneHandler` (`#if os(macOS)`): `{ story in Task {
  if await prDone.checkMerged(story: story, dir: model.storiesDirectory) == .merged { model.moveStory(story.id, to: .done) } } }`;
  pass to `BoardView`; an `.alert` bound to `prDone.lastResult`.

## Data flow
```
right-click card → "Mark done if merged" → PRDoneModel.checkMerged(story, dir)
  guard dir + token + GitRepoInfo → else lastResult=error
  merged = GitHubClient.isPullMerged(owner, repo, head="owner:sc-id/slug", token)
     merged  → lastResult="Marked done"  → ContentView: model.moveStory(id, .done)  → B write + C commit
     !merged → lastResult="PR not merged yet"
     error   → lastResult=message
```

## Error & edge
| Condition | Behavior |
|---|---|
| No PR for the branch / not merged | `.notMerged` → "PR not merged yet"; card unchanged. |
| No token / not a GitHub repo / iOS | action unavailable / `.error`. |
| Already done | Move to `.done` is a no-op in `moveStory` (same state). |
| API 401 / network | `.error`; card unchanged. |

## Testing
- **`GitHubClientTests`** (add): `isPullMerged` via stub fetch — `[{merged_at:"…"}]` → true; `[{merged_at:null}]`
  → false; `[]` → false; sends the `head` query item.
- **`PRDoneModelTests`** (SwrmUI): injected `resolveRepo` + stub client + `InMemoryTokenStore` — merged JSON →
  `.merged` + lastResult; not-merged → `.notMerged`; no token → `.error`.
- **UI**: build mac+iOS (iOS no menu item); manual — merge a story's PR on GitHub, "Mark done if merged" →
  card moves to Done + a `state: done` commit lands.

## Out of scope
Board-wide auto-sweep, webhook/polling auto-detection, "suppress if other open PRs", GitLab MRs.
