# Native CI overlay — design (Slice D2)

_Date: 2026-05-29 · Status: approved (autonomous — user said "keep buzzin")_

## Context
D1 connected a GitHub account (Keychain PAT). D2 uses that token to show a **live CI badge** for the
current repo's HEAD on the native board — the architecture doc's *"CI status is an overlay fetched live
per HEAD, never written into Markdown."* Read-only; no writes to the repo or the `.md` files.

## Decisions
1. **One board-level badge** for the repo HEAD (not per-card): green (success) / red (failure) /
   yellow (pending) / hidden (none / not a GitHub repo / not connected).
2. **Source = GitHub check-runs** for the HEAD sha, rolled up to one state (covers GitHub Actions):
   any failure-ish conclusion → failure; any run not `completed` → pending; all good → success; empty → none.
3. **macOS-only.** Resolving owner/repo (from the `origin` remote) + HEAD sha needs the git CLI
   (`Process`, like slice C). iOS shows no badge.
4. **Live, never stored.** Fetched on folder-open + a manual refresh (tap the badge); held in memory only.
5. Uses the D1 token (`TokenStore`). No token / not a GitHub repo → `.none` (badge hidden).

## Components / files

### SwrmCore
- **`GitRepoReader.swift`** (macOS-only `#if os(macOS)`) — `GitRepoInfo { owner, repo, headSHA }`;
  `info(for directory: URL) -> GitRepoInfo?`: `git rev-parse HEAD` + `git remote get-url origin`,
  parse a GitHub ssh/https remote → `(owner, repo)`. Returns nil if not a git repo / not a GitHub remote.
  Static `parseGitHubRemote(_:) -> (String, String)?` is pure + unit-tested.
- **`CIStatus.swift`** — `enum CIStatus: Equatable { case success, failure, pending, none }`.
- **`GitHubClient` + `ciStatus(...)`** — `func ciStatus(owner:repo:ref:token:) async throws -> CIStatus`:
  `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, decode `{ check_runs: [{ status, conclusion }] }`,
  roll up. Same injectable `fetch` → unit-tested with canned JSON.

### SwrmUI
- **`BoardModel`** — expose `public var storiesDirectory: URL? { currentStoriesDir }` (read-only getter)
  so the CI model can resolve the repo.
- **`CIStatusModel.swift`** (`@MainActor ObservableObject`) — `@Published status: CIStatus = .none`;
  injected `store: TokenStore`, `client: GitHubClient`, and `resolveRepo: (URL) -> GitRepoInfo?`
  (default `GitRepoReader().info` on macOS, `{ _ in nil }` on iOS — testable). `refresh(dir: URL?) async`:
  guard dir + token + repo info, else `.none`; else fetch `ciStatus`, set status (`.none` on error).

### Apps/Shared
- **`CIBadge.swift`** — a small pill: colored dot + label (`Passing`/`Failing`/`Running`/hidden) driven by
  `CIStatus`. Tapping → `Task { await ci.refresh(dir:) }`.
- **`ContentView.swift`** — owns `@StateObject ci`; a `CIBadge` toolbar item; `.task(id: model.folderName) { await ci.refresh(dir: model.storiesDirectory) }` (refresh when the folder changes) + on scenePhase active.

## Data flow
```
folder opens / refresh tapped → CIStatusModel.refresh(dir)
  guard dir + token(load) + GitRepoReader.info(dir) → else status = .none
  GitHubClient.ciStatus(owner,repo,headSHA,token)
     GET /commits/{sha}/check-runs → rollup
        any failing conclusion → .failure
        any run not completed   → .pending
        all good                → .success
        empty                   → .none
  set @Published status  (error → .none)   [never written to disk]
```

## Error & edge
| Condition | Behavior |
|---|---|
| Not connected (no token) | `.none` → badge hidden. |
| Not a git repo / non-GitHub remote | `.none`. |
| iOS | `.none` (no git resolution). |
| API 401 / network / decode | `.none` (badge hidden; the connect state surfaces auth errors in Settings). |
| Detached HEAD / no commits | `rev-parse HEAD` empty → `.none`. |
| Rate-limit / transient | `.none`; next refresh retries. |

## Testing
- **`GitRepoReaderTests`** (macOS): `parseGitHubRemote` for `git@github.com:o/r.git`, `https://github.com/o/r`,
  `https://github.com/o/r.git`, and a non-GitHub URL (nil); `info(for:)` against a temp `git init` repo with
  an `origin` remote + a commit → returns owner/repo/sha.
- **`GitHubClientTests`** (add): `ciStatus` rollup via stub `fetch` — all success → `.success`; one `failure`
  conclusion → `.failure`; an `in_progress` run → `.pending`; empty `check_runs` → `.none`.
- **`CIStatusModelTests`** (SwrmUI): injected `resolveRepo` stub + stub client + `InMemoryTokenStore`:
  token + repo + success JSON → `.success`; no token → `.none`; nil repo → `.none`.
- **UI**: build mac+iOS + manual (open a repo with Actions → badge reflects the latest run; tap to refresh).

## Out of scope (later)
Per-card CI, periodic polling, opening the checks page in a browser, the legacy combined-status API,
GitLab pipelines, push/PR (D3), PR→done (D4).
