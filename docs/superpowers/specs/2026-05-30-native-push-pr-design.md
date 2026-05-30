# Native push + open PR — design (Slice D3)

_Date: 2026-05-30 · Status: approved (autonomous build; remote-write shape confirmed with user)_

## Context
D1 connected GitHub (Keychain PAT), D2 shows live CI. D3 adds the first **remote writes**: an explicit
"Push & open PR" action that pushes the current branch to `origin` and opens a pull request into the
repo's default branch. This is the **D3** rung of the Event Modeling blueprint (`OpenPullRequest` →
`PROpened`). macOS-only (push uses the git CLI).

## Decisions (confirmed with user)
1. **Explicit button only** — never automatic. Pushes the **current branch**; opens a PR `head=<branch>`
   → `base=<default branch>`. (Branch-per-story / start-work = deferred C2.)
2. **Push auth via `http.extraHeader`** — `git -c http.extraHeader="Authorization: Bearer <token>" push
   https://github.com/<owner>/<repo>.git HEAD:<branch>`. The token is a transient `-c` arg (not written
   to git config, not in the remote URL, never logged). Works whether `origin` is SSH or HTTPS (we build
   the HTTPS URL from owner/repo).
3. **PR via REST** — `GET /repos/{o}/{r}` for `default_branch`, then `POST /repos/{o}/{r}/pulls`
   `{title, head, base}`. 422 (PR already exists / no diff) → a friendly message, not a crash.
4. **macOS-only.** iOS has no git CLI; the button is hidden / disabled there.
5. Uses the D1 token. No token / not a GitHub repo → action unavailable.

## Components / files

### SwrmCore
- **`GitPusher.swift`** (`#if os(macOS)`) — `struct GitPusher { func push(owner:repo:branch:token:) throws }`:
  runs `git -c http.extraHeader=... push https://github.com/<owner>/<repo>.git HEAD:refs/heads/<branch>`
  via `Process`; non-zero exit → `GitPushError.failed(stderr-without-token)`. Plus
  `currentBranch(in directory: URL) -> String?` (`git rev-parse --abbrev-ref HEAD`).
- **`GitHubClient` additions** — `defaultBranch(owner:repo:token:) async throws -> String` (GET repo →
  `default_branch`); `openPullRequest(owner:repo:head:base:title:token:) async throws -> PullRequestRef`
  (`POST /pulls`; 201 → `PullRequestRef{ number, htmlURL }`; 422 → `GitHubError.network("a pull request
  may already exist for this branch")`). `PullRequestRef: Equatable`.

### SwrmUI
- **`PushPRModel.swift`** (`@MainActor ObservableObject`) — `@Published state: PushState`
  (`.idle / .working / .opened(url:String) / .error(String)`). Injected `store: TokenStore`,
  `client: GitHubClient`, and seams for branch + push (`currentBranch: (URL) -> String?`,
  `push: (owner,repo,branch,token) throws`) so it's unit-testable without a real remote.
  `pushAndOpenPR(dir: URL?) async`: resolve repo+branch+token → push → defaultBranch → openPullRequest →
  `.opened(htmlURL)`; any failure → `.error`.

### Apps/Shared
- **`ContentView.swift`** — a "Push & PR" toolbar button (`#if os(macOS)`) → `Task { await pushPR.pushAndOpenPR(dir: model.storiesDirectory) }`; owns `@StateObject pushPR`. On `.opened(url)` show a small confirmation (and an "Open PR" link via `openURL`); on `.error` show the message. (Reuses the existing toolbar/sheet patterns.)

## Data flow
```
tap "Push & PR" → PushPRModel.pushAndOpenPR(dir)
  guard token + GitRepoInfo(owner,repo,sha) + currentBranch → else .error
  state=.working
  GitPusher.push(owner,repo,branch,token)                 // git push over HTTPS, token in -c extraHeader
  base = GitHubClient.defaultBranch(owner,repo,token)      // GET /repos/{o}/{r}.default_branch
  pr = GitHubClient.openPullRequest(o,r, head:branch, base, title:branch, token)
        201 → .opened(pr.htmlURL)
        422 → .error("a pull request may already exist for this branch")
  push/net/auth failure → .error(message)                  // remote unchanged on push failure
```

## Error & edge
| Condition | Behavior |
|---|---|
| No token / not a GitHub repo / iOS | Button hidden/disabled; `pushAndOpenPR` → `.error`/no-op. |
| Push rejected (no upstream perms, non-fast-forward) | `.error(stderr)`; the stderr is scrubbed of the token (token only ever in the `-c` arg, not echoed). |
| Current branch == default branch | Still pushes; PR head==base → GitHub 422 → friendly message. |
| PR already open / no commits between | 422 → `.error("a pull request may already exist for this branch")`. |
| Token never logged | The token is only ever passed as a `-c http.extraHeader` arg + `Authorization` header; never printed or written to disk. |

## Testing
- **`GitHubClientTests`** (add): `defaultBranch` parses `default_branch` from a stub `GET /repos`;
  `openPullRequest` 201 → `PullRequestRef(number, htmlURL)`; 422 → throws `.network(...)`.
- **`GitPusherTests`** (macOS): `currentBranch(in:)` against a temp `git init` repo on a named branch.
  (The actual network push is not unit-tested — verified manually; the command construction is exercised
  via the model with an injected `push` seam.)
- **`PushPRModelTests`** (SwrmUI): injected `currentBranch`/`push` seams + stub client + `InMemoryTokenStore`:
  happy path → `.opened(url)`; no token → `.error`; push-throws → `.error` and `openPullRequest` not called.
- **UI**: build mac+iOS (iOS excludes the push button); manual — connect, push a branch, see the PR open on GitHub.

## Out of scope (later)
PR→done / merge detection (D4), branch-per-story start-work (C2), draft PRs, PR templates, reviewers,
force-push, GitLab MRs.
