# Native CI Overlay (Slice D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Show a live CI badge (green/red/yellow/hidden) for the current repo's HEAD on the native macOS board, from GitHub check-runs, using the D1 token. Read-only, never stored. iOS shows nothing.

**Architecture:** `GitRepoReader` (macOS, via `git`) resolves owner/repo + HEAD sha; `GitHubClient.ciStatus` fetches check-runs and rolls them to one `CIStatus`; `CIStatusModel` (`@MainActor`) holds the live status; a `CIBadge` toolbar pill renders it and refreshes on folder-open + tap.

**Tech Stack:** Swift 6.3, SwiftPM, Foundation `Process` + URLSession, async XCTest, SwiftUI.

**Spec:** `docs/superpowers/specs/2026-05-29-native-ci-overlay-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: GitRepoReader + CIStatus + ciStatus (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/GitRepoReader.swift`, `native/SwrmCore/Sources/SwrmCore/CIStatus.swift`; Modify `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`; Create `native/SwrmCore/Tests/SwrmCoreTests/GitRepoReaderTests.swift`; Modify `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmCore/Tests/SwrmCoreTests/GitRepoReaderTests.swift`:

```swift
#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitRepoReaderTests: XCTestCase {
    func testParsesSshAndHttpsRemotes() {
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("git@github.com:ballinbigE/swrm.git").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("https://github.com/ballinbigE/swrm").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("https://github.com/ballinbigE/swrm.git").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertNil(GitRepoReader.parseGitHubRemote("https://gitlab.com/x/y.git"))
    }

    func testInfoForRealTempRepo() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-repo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) { let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a; p.standardOutput = Pipe(); p.standardError = Pipe(); try? p.run(); p.waitUntilExit() }
        git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"])
        git(["remote", "add", "origin", "git@github.com:ballinbigE/swrm.git"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        git(["add", "-A"]); git(["commit", "-m", "c"])
        let info = GitRepoReader().info(for: dir)
        XCTAssertEqual(info?.owner, "ballinbigE")
        XCTAssertEqual(info?.repo, "swrm")
        XCTAssertEqual(info?.headSHA.count, 40)
    }
}
#endif
```

Add to `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`:

```swift
    func testCIStatusRollup() async throws {
        func runs(_ json: String) -> GitHubClient { client(status: 200, body: json) }
        // all completed/success
        let ok = try await runs(#"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(ok, .success)
        // a failure
        let bad = try await runs(#"{"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(bad, .failure)
        // in progress
        let run = try await runs(#"{"check_runs":[{"status":"in_progress","conclusion":null}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(run, .pending)
        // empty
        let none = try await runs(#"{"check_runs":[]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(none, .none)
    }
```

- [ ] **Step 2: Run → fail** — `cd native/SwrmCore && swift test --filter GitRepoReaderTests` and `--filter GitHubClientTests`.

- [ ] **Step 3: Implement**

`native/SwrmCore/Sources/SwrmCore/CIStatus.swift`:

```swift
public enum CIStatus: Equatable, Sendable {
    case success, failure, pending, none
}
```

`native/SwrmCore/Sources/SwrmCore/GitRepoReader.swift`:

```swift
import Foundation

/// owner/repo + HEAD sha for a git repo. (Struct is cross-platform; the reader is macOS-only.)
public struct GitRepoInfo: Equatable, Sendable {
    public let owner: String
    public let repo: String
    public let headSHA: String
    public init(owner: String, repo: String, headSHA: String) {
        self.owner = owner; self.repo = repo; self.headSHA = headSHA
    }
}

#if os(macOS)
/// Resolves repo identity via the `git` CLI. macOS only.
public struct GitRepoReader {
    public init() {}

    public func info(for directory: URL) -> GitRepoInfo? {
        guard let sha = run(["rev-parse", "HEAD"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sha.isEmpty,
              let remote = run(["remote", "get-url", "origin"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let parsed = Self.parseGitHubRemote(remote)
        else { return nil }
        return GitRepoInfo(owner: parsed.owner, repo: parsed.repo, headSHA: sha)
    }

    public static func parseGitHubRemote(_ url: String) -> (owner: String, repo: String)? {
        guard let r = url.range(of: "github.com") else { return nil }
        var tail = String(url[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: ":/"))
        if tail.hasSuffix(".git") { tail = String(tail.dropLast(4)) }
        let parts = tail.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    private func run(_ args: [String], in dir: URL) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}
#endif
```

In `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`, add inside the `GitHubClient` struct (it can use the private `fetch`):

```swift
    public func ciStatus(owner: String, repo: String, ref: String, token: String) async throws -> CIStatus {
        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/commits/\(ref)/check-runs")!
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        let decoded: CheckRunsResponse
        do { decoded = try JSONDecoder().decode(CheckRunsResponse.self, from: data) } catch { throw GitHubError.decode }
        return GitHubClient.rollup(decoded.check_runs)
    }

    static func rollup(_ runs: [CheckRun]) -> CIStatus {
        if runs.isEmpty { return .none }
        let failing: Set<String> = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]
        if runs.contains(where: { failing.contains($0.conclusion ?? "") }) { return .failure }
        if runs.contains(where: { $0.status != "completed" }) { return .pending }
        return .success
    }
```

And at file scope in `GitHubClient.swift` (below the struct):

```swift
struct CheckRunsResponse: Codable { let check_runs: [CheckRun] }
struct CheckRun: Codable { let status: String; let conclusion: String? }
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmCore && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/GitRepoReader.swift native/SwrmCore/Sources/SwrmCore/CIStatus.swift native/SwrmCore/Sources/SwrmCore/GitHubClient.swift native/SwrmCore/Tests/SwrmCoreTests/GitRepoReaderTests.swift native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift
git commit -m "feat(core): GitRepoReader + CIStatus + GitHubClient.ciStatus (check-runs rollup)"
```

---

## Task 2: CIStatusModel + BoardModel getter (SwrmUI)

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`; Create `native/SwrmUI/Sources/SwrmUI/CIStatusModel.swift`, `native/SwrmUI/Tests/SwrmUITests/CIStatusModelTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmUI/Tests/SwrmUITests/CIStatusModelTests.swift`:

```swift
import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class CIStatusModelTests: XCTestCase {
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in
            let r = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), r)
        })
    }
    private let dummyDir = URL(fileURLWithPath: "/tmp/swrm-ci")

    func testSuccessWhenTokenRepoAndGreen() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(token: "t"),
            client: client(status: 200, body: #"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "sha") }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .success)
    }

    func testNoneWithoutToken() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(),
            client: client(status: 200, body: #"{"check_runs":[]}"#),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "sha") }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .none)
    }

    func testNoneWhenNotAGitHubRepo() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(token: "t"),
            client: client(status: 200, body: #"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#),
            resolveRepo: { _ in nil }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .none)
    }
}
```

- [ ] **Step 2: Run → fail** — `cd native/SwrmUI && swift test --filter CIStatusModelTests`.

- [ ] **Step 3: Implement**

In `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`, add a public read-only getter (place near the other public API):

```swift
    /// The resolved stories directory currently loaded (for repo/CI lookups). nil if none open.
    public var storiesDirectory: URL? { currentStoriesDir }
```

`native/SwrmUI/Sources/SwrmUI/CIStatusModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

/// Live CI status for the current repo HEAD. Read-only, never persisted.
@MainActor
public final class CIStatusModel: ObservableObject {
    @Published public private(set) var status: CIStatus = .none

    private let store: TokenStore
    private let client: GitHubClient
    private let resolveRepo: (URL) -> GitRepoInfo?

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                resolveRepo: @escaping (URL) -> GitRepoInfo? = CIStatusModel.defaultResolve) {
        self.store = store
        self.client = client
        self.resolveRepo = resolveRepo
    }

    public static let defaultResolve: (URL) -> GitRepoInfo? = { dir in
        #if os(macOS)
        return GitRepoReader().info(for: dir)
        #else
        return nil
        #endif
    }

    public func refresh(dir: URL?) async {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir) else { status = .none; return }
        do {
            status = try await client.ciStatus(owner: info.owner, repo: info.repo, ref: info.headSHA, token: token)
        } catch {
            status = .none
        }
    }
}
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmUI && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Sources/SwrmUI/CIStatusModel.swift native/SwrmUI/Tests/SwrmUITests/CIStatusModelTests.swift
git commit -m "feat(ui): CIStatusModel — live HEAD CI status; BoardModel.storiesDirectory"
```

---

## Task 3: CIBadge + ContentView (Apps)

**Files:** Create `native/Apps/Shared/CIBadge.swift`; Modify `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Create CIBadge**

`native/Apps/Shared/CIBadge.swift`:

```swift
import SwiftUI
import SwrmCore

/// A small CI pill for the repo HEAD. Hidden when status is `.none`.
struct CIBadge: View {
    let status: CIStatus
    var onTap: () -> Void

    var body: some View {
        if let info = display {
            Button(action: onTap) {
                HStack(spacing: 5) {
                    Circle().fill(info.color).frame(width: 8, height: 8)
                    Text(info.label).font(.caption)
                }
            }
            .buttonStyle(.plain)
            .help("CI for HEAD — tap to refresh")
        }
    }

    private var display: (label: String, color: Color)? {
        switch status {
        case .success: return ("Passing", .green)
        case .failure: return ("Failing", .red)
        case .pending: return ("Running", .yellow)
        case .none: return nil
        }
    }
}
```

- [ ] **Step 2: Wire into ContentView**

In `native/Apps/Shared/ContentView.swift`:
- Add `@StateObject private var ci = CIStatusModel()`.
- In the existing toolbar group add `CIBadge(status: ci.status) { Task { await ci.refresh(dir: model.storiesDirectory) } }`.
- Add `.task(id: model.folderName) { await ci.refresh(dir: model.storiesDirectory) }` on the NavigationStack (re-fetches whenever the open folder changes).

- [ ] **Step 3: Build**
```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` both (iOS compiles: `GitRepoInfo` exists, `GitRepoReader` excluded, `defaultResolve` returns nil).

- [ ] **Step 4: Commit**
```bash
git add native/Apps/Shared/CIBadge.swift native/Apps/Shared/ContentView.swift
git commit -m "feat(app): CI badge on the board toolbar (live HEAD status)"
```

---

## Task 4: Verify

- [ ] `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )` → green.
- [ ] Both `xcodebuild` builds succeed.
- [ ] Manual (macOS): connect GitHub (D1), open a `.swrm/stories` dir in a repo with GitHub Actions → badge shows Passing/Failing/Running; tap → refetches.

---

## Self-Review
- **Spec coverage:** GitHub-remote parse (T1) · repo+sha resolution macOS (T1) · check-runs rollup incl. failure/pending/empty (T1) · CIStatusModel none-without-token / none-without-repo / success (T2) · BoardModel.storiesDirectory (T2) · badge UI + hidden on none (T3) · refresh on folder change + tap (T3) · iOS compiles, no badge (T3). Read-only/never-stored honored (status is in-memory `@Published`). Per-card CI / polling / push / PR out of scope.
- **Placeholders:** none.
- **Type consistency:** `GitRepoInfo(owner:repo:headSHA:)`, `GitRepoReader().info(for:)`/`parseGitHubRemote`, `CIStatus`, `GitHubClient.ciStatus(owner:repo:ref:token:)` + `rollup`, `CIStatusModel(store:client:resolveRepo:).refresh(dir:)`, `BoardModel.storiesDirectory`, `CIBadge(status:onTap:)` — consistent.
```
