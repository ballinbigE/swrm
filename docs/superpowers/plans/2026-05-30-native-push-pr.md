# Native Push + Open PR (Slice D3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** An explicit "Push & PR" button on the macOS board: push the current branch to origin (token via `http.extraHeader`) and open a PR into the repo's default branch. Token never logged/persisted. iOS: no button.

**Architecture:** `GitPusher` (macOS, `git push` via `Process`) + `GitHubClient.defaultBranch`/`openPullRequest` in SwrmCore; `PushPRModel` (`@MainActor`, push+branch seams injectable for tests) in SwrmUI; a `#if os(macOS)` toolbar button in Apps.

**Tech Stack:** Swift 6.3, SwiftPM, Foundation `Process` + URLSession, async XCTest, SwiftUI.

**Spec:** `docs/superpowers/specs/2026-05-30-native-push-pr-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: GitPusher + PR API (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/GitPusher.swift`; Modify `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`; Create `native/SwrmCore/Tests/SwrmCoreTests/GitPusherTests.swift`; Modify `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmCore/Tests/SwrmCoreTests/GitPusherTests.swift`:

```swift
#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitPusherTests: XCTestCase {
    func testCurrentBranch() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-push-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) { let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a; p.standardOutput = Pipe(); p.standardError = Pipe(); try? p.run(); p.waitUntilExit() }
        git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        git(["add", "-A"]); git(["commit", "-m", "c"]); git(["branch", "-M", "feature-xyz"])
        XCTAssertEqual(GitPusher().currentBranch(in: dir), "feature-xyz")
    }
}
#endif
```

Add to `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`:

```swift
    func testDefaultBranch() async throws {
        let c = client(status: 200, body: #"{"default_branch":"main"}"#)
        let b = try await c.defaultBranch(owner: "o", repo: "r", token: "t")
        XCTAssertEqual(b, "main")
    }

    func testOpenPullRequestReturnsRef() async throws {
        let c = client(status: 201, body: #"{"number":7,"html_url":"https://github.com/o/r/pull/7"}"#)
        let pr = try await c.openPullRequest(owner: "o", repo: "r", head: "feat", base: "main", title: "feat", token: "t")
        XCTAssertEqual(pr, PullRequestRef(number: 7, htmlURL: "https://github.com/o/r/pull/7"))
    }

    func testOpenPullRequest422IsFriendlyError() async {
        let c = client(status: 422, body: #"{"message":"Validation Failed"}"#)
        do { _ = try await c.openPullRequest(owner: "o", repo: "r", head: "feat", base: "main", title: "feat", token: "t"); XCTFail() }
        catch { if case let GitHubError.network(m) = error { XCTAssertTrue(m.contains("already exist")) } else { XCTFail("\(error)") } }
    }
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`native/SwrmCore/Sources/SwrmCore/GitPusher.swift`:

```swift
#if os(macOS)
import Foundation

public enum GitPushError: Error, Equatable { case failed(String) }

/// Pushes the current branch to GitHub over HTTPS, authenticating with a token via a
/// transient `-c http.extraHeader` arg (not persisted, not in the URL). macOS only.
public struct GitPusher {
    public init() {}

    public func currentBranch(in directory: URL) -> String? {
        guard let out = run(["rev-parse", "--abbrev-ref", "HEAD"], in: directory)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !out.isEmpty, out != "HEAD" else { return nil }
        return out
    }

    public func push(owner: String, repo: String, branch: String, token: String, in directory: URL) throws {
        let url = "https://github.com/\(owner)/\(repo).git"
        let (status, _, err) = capture(
            ["-c", "http.extraHeader=Authorization: Bearer \(token)",
             "push", url, "HEAD:refs/heads/\(branch)"],
            in: directory)
        guard status == 0 else {
            throw GitPushError.failed(err.replacingOccurrences(of: token, with: "***"))
        }
    }

    private func run(_ args: [String], in dir: URL) -> String? {
        let (s, out, _) = capture(args, in: dir)
        return s == 0 ? out : nil
    }
    private func capture(_ args: [String], in dir: URL) -> (Int32, String, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let o = Pipe(); let e = Pipe(); p.standardOutput = o; p.standardError = e
        do { try p.run() } catch { return (-1, "", "\(error)") }
        p.waitUntilExit()
        let out = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: e.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus, out, err)
    }
}
#endif
```

In `GitHubClient.swift`, add a `PullRequestRef` (file scope) + two methods inside the struct:

```swift
public struct PullRequestRef: Equatable {
    public let number: Int
    public let htmlURL: String
    public init(number: Int, htmlURL: String) { self.number = number; self.htmlURL = htmlURL }
}
```

Inside `struct GitHubClient`:

```swift
    public func defaultBranch(owner: String, repo: String, token: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct Repo: Codable { let default_branch: String }
        do { return try JSONDecoder().decode(Repo.self, from: data).default_branch } catch { throw GitHubError.decode }
    }

    public func openPullRequest(owner: String, repo: String, head: String, base: String, title: String, token: String) async throws -> PullRequestRef {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)/pulls")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["title": title, "head": head, "base": base])
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        if http.statusCode == 422 { throw GitHubError.network("a pull request may already exist for this branch") }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct PR: Codable { let number: Int; let html_url: String }
        do { let pr = try JSONDecoder().decode(PR.self, from: data); return PullRequestRef(number: pr.number, htmlURL: pr.html_url) }
        catch { throw GitHubError.decode }
    }
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmCore && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/GitPusher.swift native/SwrmCore/Sources/SwrmCore/GitHubClient.swift native/SwrmCore/Tests/SwrmCoreTests/GitPusherTests.swift native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift
git commit -m "feat(core): GitPusher (token via extraHeader) + GitHubClient PR API"
```

---

## Task 2: PushPRModel (SwrmUI)

**Files:** Create `native/SwrmUI/Sources/SwrmUI/PushPRModel.swift`, `native/SwrmUI/Tests/SwrmUITests/PushPRModelTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmUI/Tests/SwrmUITests/PushPRModelTests.swift`:

```swift
import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class PushPRModelTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/swrm-pushpr")
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in
            let r = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), r)
        })
    }
    // a client that returns default_branch then a PR depending on the path
    private func prClient() -> GitHubClient {
        GitHubClient(fetch: { req in
            let path = req.url!.path
            let body = path.hasSuffix("/pulls")
                ? #"{"number":7,"html_url":"https://github.com/o/r/pull/7"}"#
                : #"{"default_branch":"main"}"#
            let status = path.hasSuffix("/pulls") ? 201 : 200
            return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
    }

    func testHappyPathOpensPR() async {
        var pushed = false
        let m = PushPRModel(
            store: InMemoryTokenStore(token: "tok"), client: prClient(),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" },
            push: { _, _, _, _, _ in pushed = true }
        )
        await m.pushAndOpenPR(dir: dir)
        XCTAssertTrue(pushed)
        XCTAssertEqual(m.state, .opened(url: "https://github.com/o/r/pull/7"))
    }

    func testNoTokenErrors() async {
        let m = PushPRModel(store: InMemoryTokenStore(), client: prClient(),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" }, push: { _, _, _, _, _ in })
        await m.pushAndOpenPR(dir: dir)
        if case .error = m.state {} else { XCTFail("\(m.state)") }
    }

    func testPushFailureStopsBeforePR() async {
        var prOpened = false
        let m = PushPRModel(
            store: InMemoryTokenStore(token: "tok"),
            client: GitHubClient(fetch: { req in prOpened = req.url!.path.hasSuffix("/pulls"); return (Data("{}".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" },
            push: { _, _, _, _, _ in throw GitPushErrorStub.boom }
        )
        await m.pushAndOpenPR(dir: dir)
        if case .error = m.state {} else { XCTFail("\(m.state)") }
        XCTAssertFalse(prOpened)
    }
}

enum GitPushErrorStub: Error { case boom }
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `native/SwrmUI/Sources/SwrmUI/PushPRModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

public enum PushState: Equatable {
    case idle
    case working
    case opened(url: String)
    case error(String)
}

/// Push the current branch + open a PR. Push/branch are injectable seams so the
/// orchestration is unit-testable without a real remote.
@MainActor
public final class PushPRModel: ObservableObject {
    @Published public private(set) var state: PushState = .idle

    private let store: TokenStore
    private let client: GitHubClient
    private let resolveRepo: (URL) -> GitRepoInfo?
    private let currentBranch: (URL) -> String?
    private let push: (String, String, String, String, URL) throws -> Void

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                resolveRepo: @escaping (URL) -> GitRepoInfo? = CIStatusModel.defaultResolve,
                currentBranch: @escaping (URL) -> String? = PushPRModel.resolveCurrentBranch,
                push: @escaping (String, String, String, String, URL) throws -> Void = PushPRModel.defaultPush) {
        self.store = store
        self.client = client
        self.resolveRepo = resolveRepo
        self.currentBranch = currentBranch
        self.push = push
    }

    public static let resolveCurrentBranch: (URL) -> String? = { dir in
        #if os(macOS)
        return GitPusher().currentBranch(in: dir)
        #else
        return nil
        #endif
    }
    public static let defaultPush: (String, String, String, String, URL) throws -> Void = { owner, repo, branch, token, dir in
        #if os(macOS)
        try GitPusher().push(owner: owner, repo: repo, branch: branch, token: token, in: dir)
        #else
        throw GitHubError.network("push unavailable on iOS")
        #endif
    }

    public func reset() { state = .idle }

    public func pushAndOpenPR(dir: URL?) async {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir),
              let branch = currentBranch(dir) else {
            state = .error("Connect GitHub and open a git repo first")
            return
        }
        state = .working
        do {
            try push(info.owner, info.repo, branch, token, dir)
            let base = try await client.defaultBranch(owner: info.owner, repo: info.repo, token: token)
            let pr = try await client.openPullRequest(owner: info.owner, repo: info.repo, head: branch, base: base, title: branch, token: token)
            state = .opened(url: pr.htmlURL)
        } catch let e as GitHubError {
            switch e {
            case .unauthorized: state = .error("Token not authorized for this repo")
            case .network(let m): state = .error(m)
            case .decode: state = .error("Unexpected response from GitHub")
            }
        } catch {
            state = .error("Push failed")
        }
    }
}
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmUI && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmUI/Sources/SwrmUI/PushPRModel.swift native/SwrmUI/Tests/SwrmUITests/PushPRModelTests.swift
git commit -m "feat(ui): PushPRModel — push current branch + open PR (testable seams)"
```

---

## Task 3: Push & PR button (Apps)

**Files:** Modify `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Wire it (macOS-only)**

In `native/Apps/Shared/ContentView.swift`:
- Add `@StateObject private var pushPR = PushPRModel()` and `@Environment(\.openURL) private var openURL`.
- In the toolbar group, add (macOS only):
```swift
#if os(macOS)
Button {
    Task { await pushPR.pushAndOpenPR(dir: model.storiesDirectory) }
} label: {
    if case .working = pushPR.state { ProgressView() } else { Label("Push & PR", systemImage: "arrow.up.circle") }
}
.disabled({ if case .working = pushPR.state { return true } else { return false } }())
#endif
```
- Add an alert on the NavigationStack that fires when push finishes:
```swift
.alert("Push & PR", isPresented: Binding(
    get: {
        switch pushPR.state { case .opened, .error: return true; default: return false }
    },
    set: { if !$0 { pushPR.reset() } }
)) {
    if case let .opened(url) = pushPR.state, let u = URL(string: url) {
        Button("Open PR") { openURL(u) }
    }
    Button("OK", role: .cancel) { }
} message: {
    switch pushPR.state {
    case .opened(let url): Text("Pull request opened:\n\(url)")
    case .error(let m): Text(m)
    default: Text("")
    }
}
```

- [ ] **Step 2: Build**
```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` both (iOS: the button is `#if os(macOS)`; `PushPRModel` compiles via the iOS branches of its static closures).

- [ ] **Step 3: Commit**
```bash
git add native/Apps/Shared/ContentView.swift
git commit -m "feat(app): Push & open PR button (macOS)"
```

---

## Task 4: Verify
- [ ] `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )` → green.
- [ ] Both `xcodebuild` builds succeed.
- [ ] Manual (macOS): connect GitHub, on a feature branch with commits, tap "Push & PR" → branch pushed + PR opens on GitHub; "Open PR" link works; a second tap → friendly "may already exist" message.

---

## Self-Review
- **Spec coverage:** push current branch via `http.extraHeader` token (T1) · currentBranch (T1) · defaultBranch + openPullRequest + 422 (T1) · PushPRModel orchestration: happy/no-token/push-fail-stops-before-PR (T2) · explicit button, macOS-only, alert with Open-PR (T3) · iOS compiles, no button (T3). Token scrubbed from push stderr, only in `-c` arg + Bearer header, never logged. PR→done / C2 out of scope.
- **Placeholders:** none.
- **Type consistency:** `GitPusher().push(owner:repo:branch:token:in:)` + `currentBranch(in:)`, `GitPushError.failed`, `PullRequestRef(number:htmlURL:)`, `GitHubClient.defaultBranch/openPullRequest`, `PushPRModel(store:client:resolveRepo:currentBranch:push:)` + `pushAndOpenPR(dir:)`/`reset()`, `PushState` — consistent.
```
