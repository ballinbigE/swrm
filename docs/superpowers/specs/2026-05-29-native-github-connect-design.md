# Native GitHub connect — design (Slice D1)

_Date: 2026-05-29 · Status: approved design, pre-plan_

## Context
Slice D (providers + auth + CI) decomposes into D1 connect-account → D2 CI overlay → D3 push+PR →
D4 PR→done. **D1 is the foundation:** securely store a GitHub Personal Access Token and prove it's
valid, so D2–D4 have an authenticated client. Chosen: **GitHub**, **fine-grained PAT**, **cross-platform
(macOS + iOS)** — Keychain + URLSession work on both. (GitLab + OAuth are later; a `TokenStore`/client
seam keeps them addable.)

The one PAT serves everything downstream: the REST API (PR, CI) *and* `git push` over HTTPS.

## Decisions
1. **GitHub, fine-grained PAT.** User pastes a token (scoped to their repo: Contents R/W, Pull requests
   R/W, Commit statuses + Checks R). D1 only needs it to validate identity; the repo scopes matter in D2+.
2. **Single global token** (one connected GitHub account), not per-project. Stored in the **Keychain**.
3. **Protocol seams for testability:** `TokenStore` protocol (Keychain + in-memory impls); `GitHubClient`
   with an **injectable `fetch`** so the API path is unit-tested with canned responses, no network.
4. **Validate on connect, trust on restore.** `connect` calls `GET /user`; `restore` (launch) shows the
   cached login from the stored token without a network round-trip. Real auth failures surface later when
   an actual API call (D2+) returns 401.
5. **Security:** the token lives only in the Keychain — never in UserDefaults, never logged, never in a
   commit. Only the non-secret `login` is cached (UserDefaults) for the restore label. Sent as
   `Authorization: Bearer <token>`.

## Components / files

### SwrmCore (Foundation + Security + URLSession; no UI; unit-tested)
- **`TokenStore.swift`** — `protocol TokenStore { func save(_ token: String) throws; func load() throws -> String?; func delete() throws }`; `InMemoryTokenStore` (tests).
- **`KeychainTokenStore.swift`** — `TokenStore` over `SecItem` generic-password (service `swrm.github`, account `token`, `kSecAttrAccessibleAfterFirstUnlock`). macOS + iOS.
- **`GitHubClient.swift`** —
  - `struct GitHubAccount: Codable, Equatable { let login: String; let name: String? }`
  - `enum GitHubError: Error, Equatable { case unauthorized; case network(String); case decode }`
  - `struct GitHubClient { init(fetch: @escaping (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }); func currentUser(token: String) async throws -> GitHubAccount }`
  - `currentUser`: `GET https://api.github.com/user`, headers `Authorization: Bearer <token>`,
    `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. 200 → decode `GitHubAccount`
    (decode failure → `.decode`); 401 → `.unauthorized`; other/transport → `.network(desc)`.

### SwrmUI
- **`AccountModel.swift`** (`@MainActor ObservableObject`) — `@Published state: AccountState`
  (`.disconnected / .connecting / .connected(GitHubAccount) / .error(String)`). Holds a `TokenStore` +
  `GitHubClient` (+ a `UserDefaults` for the cached login). `connect(token:) async` (validate → save token
  + cache login → `.connected`; failure → `.error`, no save), `disconnect()` (delete token + clear login →
  `.disconnected`), `restore()` (token present → `.connected(cachedLogin)`, else `.disconnected`).

### Apps/Shared
- **`SettingsView.swift`** — a sheet. GitHub section: `.disconnected` → `SecureField` (PAT) + "Connect";
  `.connecting` → progress; `.connected` → "Connected as @login" + "Disconnect"; `.error` → message + retry.
- **`ContentView.swift`** — a gear `ToolbarItem` presenting the `SettingsView` sheet; owns an
  `@StateObject AccountModel` (or `@StateObject` in SettingsView) restored on appear.

## Data flow
```
Connect:  paste PAT → AccountModel.connect(token)
            state=.connecting → GitHubClient.currentUser(token)
              200 → TokenStore.save(token); cache login; state=.connected(account)
              401 → state=.error("Invalid or expired token")     (token NOT saved)
              net → state=.error("Couldn't reach GitHub")        (token NOT saved)
Restore (launch): TokenStore.load() → token? yes → state=.connected(cachedLogin) ; no → .disconnected
Disconnect: TokenStore.delete(); clear cached login → state=.disconnected
```

## Error & edge
| Condition | Behavior |
|---|---|
| 401 from `/user` | `.error("Invalid or expired token")`; token not saved. |
| Network/transport failure | `.error("Couldn't reach GitHub")`; token not saved. |
| Empty/whitespace token | Connect disabled / no-op (validate before calling). |
| Keychain save/delete fails | Surface `.error("Keychain unavailable")`; don't claim connected. |
| Restore with a since-revoked token | Shows `.connected` (cached login); the failure surfaces on the first real API call in D2+. |
| Token logging | Never — the token is not interpolated into any log/`print`/error string. |

## Testing
- **`GitHubClientTests`** (SwrmCore): inject a stub `fetch`. 200 + valid user JSON → returns
  `GitHubAccount(login:…)`; 401 → throws `.unauthorized`; malformed JSON → `.decode`; the request carries
  the `Authorization: Bearer` + `Accept` headers. Fully deterministic, no network.
- **`AccountModelTests`** (SwrmUI): `InMemoryTokenStore` + `GitHubClient(stub)`. connect(valid) →
  `.connected` + token saved; connect(401) → `.error` + token absent; disconnect → token gone +
  `.disconnected`; restore with a pre-seeded token → `.connected`.
- **`KeychainTokenStoreTests`** (SwrmCore): best-effort round-trip (save→load→delete) on the test host;
  skip (XCTSkip) if `SecItemAdd` returns an entitlement/keychain-unavailable error in the headless env.
- **UI**: build mac+iOS + manual (paste a real fine-grained PAT → "Connected as @you"; Disconnect).

## Out of scope (later D sub-slices)
Repo operations — push (D3), open PR (D3), PR→done (D4), CI overlay (D2); OAuth device flow; GitLab;
multiple accounts; token-expiry reminders; scope verification.
