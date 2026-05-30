# Native PR→done (Slice D4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A per-card "Mark done if merged" action (macOS): check GitHub for a merged PR on the story's branch; if merged, move the card to Done (reuses B write-back + C commit). Closes the native A–D loop → v1.0.0.

**Architecture:** `GitHubClient.isPullMerged` in SwrmCore; `PRDoneModel` (`@MainActor`) in SwrmUI; a context-menu item wired to `BoardModel.moveStory(_, to: .done)` in Apps.

**Spec:** `docs/superpowers/specs/2026-05-30-native-pr-done-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: isPullMerged + PRDoneModel

**Files:** Modify `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`, `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`; Create `native/SwrmUI/Sources/SwrmUI/PRDoneModel.swift`, `native/SwrmUI/Tests/SwrmUITests/PRDoneModelTests.swift`

- [ ] **Step 1: Failing tests**

Add to `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`:

```swift
    func testIsPullMergedTrueWhenMergedAtPresent() async throws {
        let c = client(status: 200, body: #"[{"merged_at":"2026-05-30T00:00:00Z"}]"#)
        let merged = try await c.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        XCTAssertTrue(merged)
    }
    func testIsPullMergedFalseWhenNullOrEmpty() async throws {
        let n = client(status: 200, body: #"[{"merged_at":null}]"#)
        XCTAssertFalse(try await n.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t"))
        let e = client(status: 200, body: "[]")
        XCTAssertFalse(try await e.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t"))
    }
    func testIsPullMergedSendsHeadQueryItem() async throws {
        var captured: URLRequest?
        let c = GitHubClient(fetch: { req in
            captured = req
            return (Data("[]".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        _ = try await c.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        let comps = URLComponents(url: captured!.url!, resolvingAgainstBaseURL: false)
        XCTAssertEqual(comps?.queryItems?.first(where: { $0.name == "head" })?.value, "o:feat")
    }
```

`native/SwrmUI/Tests/SwrmUITests/PRDoneModelTests.swift`:

```swift
import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class PRDoneModelTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/swrm-prdone")
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!) })
    }
    private func repo(_ info: GitRepoInfo?) -> (URL) -> GitRepoInfo? { { _ in info } }

    func testMerged() async {
        let m = PRDoneModel(store: InMemoryTokenStore(token: "t"),
                            client: client(status: 200, body: #"[{"merged_at":"2026-05-30T00:00:00Z"}]"#),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        let r = await m.checkMerged(story: Story(id: "sc-1", body: "x"), dir: dir)
        XCTAssertEqual(r, .merged)
        XCTAssertEqual(m.lastResult, "Marked done")
    }
    func testNotMerged() async {
        let m = PRDoneModel(store: InMemoryTokenStore(token: "t"),
                            client: client(status: 200, body: "[]"),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        XCTAssertEqual(await m.checkMerged(story: Story(id: "sc-1"), dir: dir), .notMerged)
    }
    func testNoTokenIsError() async {
        let m = PRDoneModel(store: InMemoryTokenStore(),
                            client: client(status: 200, body: "[]"),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        if case .error = await m.checkMerged(story: Story(id: "sc-1"), dir: dir) {} else { XCTFail() }
    }
}
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

Inside `struct GitHubClient` (uses private `fetch`):

```swift
    public func isPullMerged(owner: String, repo: String, head: String, token: String) async throws -> Bool {
        var comps = URLComponents(string: "https://api.github.com/repos/\(owner)/\(repo)/pulls")!
        comps.queryItems = [
            URLQueryItem(name: "state", value: "all"),
            URLQueryItem(name: "head", value: head),
            URLQueryItem(name: "per_page", value: "10"),
        ]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct PR: Codable { let merged_at: String? }
        do { return try JSONDecoder().decode([PR].self, from: data).contains { $0.merged_at != nil } }
        catch { throw GitHubError.decode }
    }
```

`native/SwrmUI/Sources/SwrmUI/PRDoneModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

public enum MergeResult: Equatable { case merged, notMerged, error(String) }

/// Checks whether a story's branch PR has merged. The card move is done by the caller
/// (BoardModel.moveStory(.done)). Read-only here.
@MainActor
public final class PRDoneModel: ObservableObject {
    @Published public private(set) var lastResult: String?

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

    @discardableResult
    public func checkMerged(story: Story, dir: URL?) async -> MergeResult {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir) else {
            lastResult = "Connect GitHub and open a repo first"
            return .error("no context")
        }
        let head = "\(info.owner):\(story.branchName())"
        do {
            let merged = try await client.isPullMerged(owner: info.owner, repo: info.repo, head: head, token: token)
            lastResult = merged ? "Marked done" : "PR not merged yet"
            return merged ? .merged : .notMerged
        } catch {
            lastResult = "Couldn't check the PR"
            return .error("check failed")
        }
    }

    public func clear() { lastResult = nil }
}
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmCore && swift test` and `cd native/SwrmUI && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/GitHubClient.swift native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift native/SwrmUI/Sources/SwrmUI/PRDoneModel.swift native/SwrmUI/Tests/SwrmUITests/PRDoneModelTests.swift
git commit -m "feat(core+ui): isPullMerged + PRDoneModel — detect a merged PR for a story"
```

---

## Task 2: "Mark done if merged" menu (Apps + BoardView)

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardView.swift`, `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Add onCheckDone to BoardView**

In `BoardView.swift`: add `public var onCheckDone: ((Story) -> Void)?` to `BoardView` (extend `init`, default nil) + `ColumnView`; extend the card's `.contextMenu` to also show a "Mark done if merged" button when non-nil:

```swift
                    .contextMenu {
                        if let onStartWork {
                            Button { onStartWork(story) } label: { Label("Start work", systemImage: "arrow.branch") }
                        }
                        if let onCheckDone {
                            Button { onCheckDone(story) } label: { Label("Mark done if merged", systemImage: "checkmark.seal") }
                        }
                    }
```
Pass `onCheckDone` from `BoardView` → each `ColumnView`. (`BoardView.init` now `init(board:onMove:onStartWork:onCheckDone:)`, all closures default nil.)

- [ ] **Step 2: Wire in ContentView**

In `ContentView.swift`:
- Add `@StateObject private var prDone = PRDoneModel()`.
- Add the handler:
```swift
    private var checkDoneHandler: ((Story) -> Void)? {
        #if os(macOS)
        return { story in
            Task {
                if await prDone.checkMerged(story: story, dir: model.storiesDirectory) == .merged {
                    model.moveStory(story.id, to: .done)
                }
            }
        }
        #else
        return nil
        #endif
    }
```
- Pass it: `BoardView(board: board, onMove: { id, s in model.moveStory(id, to: s) }, onStartWork: startWorkHandler, onCheckDone: checkDoneHandler)`.
- Add an alert:
```swift
        .alert("Mark done", isPresented: Binding(
            get: { prDone.lastResult != nil },
            set: { if !$0 { prDone.clear() } }
        )) {
            Button("OK", role: .cancel) { }
        } message: { Text(prDone.lastResult ?? "") }
```

- [ ] **Step 3: Build**
```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` both (iOS: `checkDoneHandler` nil → no menu item).

- [ ] **Step 4: Commit**
```bash
git add native/SwrmUI/Sources/SwrmUI/BoardView.swift native/Apps/Shared/ContentView.swift
git commit -m "feat(app): Mark done if merged — close a story when its PR merges (macOS)"
```

---

## Task 3: Verify
- [ ] `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )` → green.
- [ ] Both `xcodebuild` builds succeed.
- [ ] Manual (macOS): for a story whose PR is merged on GitHub, "Mark done if merged" → card moves to Done + a `state: done` commit lands; for an open PR → "PR not merged yet".

---

## Self-Review
- **Spec coverage:** isPullMerged true/false/empty + head query (T1) · PRDoneModel merged/notMerged/no-token (T1) · context-menu action (T2) · merged → moveStory(.done) reuse (T2) · iOS no menu (T2) · alert feedback (T2). Auto-sweep / webhook out of scope.
- **Placeholders:** none.
- **Type consistency:** `GitHubClient.isPullMerged(owner:repo:head:token:) -> Bool`, `PRDoneModel(store:client:resolveRepo:).checkMerged(story:dir:) -> MergeResult` + `lastResult`/`clear()`, `MergeResult`, `BoardView(board:onMove:onStartWork:onCheckDone:)`, `BoardModel.moveStory(_:to:)`, `Story.branchName()` — consistent.
```
