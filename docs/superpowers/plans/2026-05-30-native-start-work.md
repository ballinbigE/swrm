# Native "Start work" (branch-per-story, Slice C2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A per-card "Start work" context-menu action (macOS) that creates + checks out the story's branch (`Story.branchName()` → `sc-id/slug`), or switches to it if it exists. Local git only; iOS shows no menu item.

**Architecture:** `GitBrancher` (macOS, `git switch` via `Process`) in SwrmCore; `BranchModel` (`@MainActor`, injectable brancher seam) in SwrmUI; a `.contextMenu` on the board card wired in Apps.

**Tech Stack:** Swift 6.3, SwiftPM, Foundation `Process`, XCTest, SwiftUI.

**Spec:** `docs/superpowers/specs/2026-05-30-native-start-work-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: GitBrancher + BranchModel

**Files:** Create `native/SwrmCore/Sources/SwrmCore/GitBrancher.swift`, `native/SwrmCore/Tests/SwrmCoreTests/GitBrancherTests.swift`, `native/SwrmUI/Sources/SwrmUI/BranchModel.swift`, `native/SwrmUI/Tests/SwrmUITests/BranchModelTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmCore/Tests/SwrmCoreTests/GitBrancherTests.swift`:

```swift
#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitBrancherTests: XCTestCase {
    func testCreatesAndSwitches() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-br-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) -> String {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a
            let o = Pipe(); p.standardOutput = o; p.standardError = Pipe(); try? p.run(); p.waitUntilExit()
            return String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        }
        _ = git(["init"]); _ = git(["config", "user.email", "t@t"]); _ = git(["config", "user.name", "t"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        _ = git(["add", "-A"]); _ = git(["commit", "-m", "c"])

        try GitBrancher().createOrSwitch(branch: "sc-1/x", in: dir)
        XCTAssertEqual(git(["rev-parse", "--abbrev-ref", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines), "sc-1/x")
        // already exists → switch, no throw
        XCTAssertNoThrow(try GitBrancher().createOrSwitch(branch: "sc-1/x", in: dir))
    }
}
#endif
```

`native/SwrmUI/Tests/SwrmUITests/BranchModelTests.swift`:

```swift
import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class BranchModelTests: XCTestCase {
    func testStartWorkCallsBrancherWithStoryBranch() {
        var captured: (String, URL)?
        let m = BranchModel(brancher: { b, d in captured = (b, d) })
        let story = Story(id: "sc-1", body: "Wire up the login screen")
        m.startWork(story: story, dir: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(captured?.0, story.branchName())
        XCTAssertEqual(m.lastResult, "On \(story.branchName())")
    }

    func testNilDirErrorsAndDoesNotCallBrancher() {
        var called = false
        let m = BranchModel(brancher: { _, _ in called = true })
        m.startWork(story: Story(id: "sc-1"), dir: nil)
        XCTAssertFalse(called)
        XCTAssertNotNil(m.lastResult)
    }

    func testBrancherThrowSetsError() {
        let m = BranchModel(brancher: { _, _ in throw NSError(domain: "x", code: 1) })
        m.startWork(story: Story(id: "sc-1"), dir: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(m.lastResult, "Couldn't create branch")
    }
}
```

- [ ] **Step 2: Run → fail** — `cd native/SwrmCore && swift test --filter GitBrancherTests` ; `cd native/SwrmUI && swift test --filter BranchModelTests`.

- [ ] **Step 3: Implement**

`native/SwrmCore/Sources/SwrmCore/GitBrancher.swift`:

```swift
#if os(macOS)
import Foundation

public enum GitBranchError: Error, Equatable { case failed(String) }

/// Creates + checks out a branch (or switches to it if it already exists). macOS only.
public struct GitBrancher {
    public init() {}

    public func createOrSwitch(branch: String, in directory: URL) throws {
        let (s, _, err) = capture(["switch", "-c", branch], in: directory)
        if s == 0 { return }
        let (s2, _, err2) = capture(["switch", branch], in: directory)
        guard s2 == 0 else { throw GitBranchError.failed(err + err2) }
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

`native/SwrmUI/Sources/SwrmUI/BranchModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

/// "Start work" — create + check out a story's branch. `brancher` is an injectable
/// seam so it's unit-testable without git.
@MainActor
public final class BranchModel: ObservableObject {
    @Published public private(set) var lastResult: String?

    private let brancher: (String, URL) throws -> Void

    public init(brancher: @escaping (String, URL) throws -> Void = BranchModel.defaultBrancher) {
        self.brancher = brancher
    }

    public static let defaultBrancher: (String, URL) throws -> Void = { branch, dir in
        #if os(macOS)
        try GitBrancher().createOrSwitch(branch: branch, in: dir)
        #else
        throw NSError(domain: "swrm.branch", code: 1)  // iOS: unsupported (UI hides the action)
        #endif
    }

    public func startWork(story: Story, dir: URL?) {
        guard let dir else { lastResult = "Open a git repo first"; return }
        let branch = story.branchName()
        do {
            try brancher(branch, dir)
            lastResult = "On \(branch)"
        } catch {
            lastResult = "Couldn't create branch"
        }
    }

    public func clear() { lastResult = nil }
}
```

- [ ] **Step 4: Run → pass** — both `--filter` runs, then full `cd native/SwrmCore && swift test` and `cd native/SwrmUI && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/GitBrancher.swift native/SwrmCore/Tests/SwrmCoreTests/GitBrancherTests.swift native/SwrmUI/Sources/SwrmUI/BranchModel.swift native/SwrmUI/Tests/SwrmUITests/BranchModelTests.swift
git commit -m "feat(core+ui): GitBrancher + BranchModel — start work on a story's branch"
```

---

## Task 2: "Start work" context menu (Apps + BoardView)

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardView.swift`; Modify `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Thread onStartWork through BoardView**

In `native/SwrmUI/Sources/SwrmUI/BoardView.swift`:
- Add to `BoardView`: `public var onStartWork: ((Story) -> Void)?` + extend the `init` to accept it (default nil); pass it to `ColumnView`.
- In `ColumnView`: add `var onStartWork: ((Story) -> Void)?`; apply a context menu to each card:
```swift
            ForEach(column.stories, id: \.id) { story in
                StoryCardView(story: story)
                    .draggable(story.id)
                    .contextMenu {
                        if let onStartWork {
                            Button { onStartWork(story) } label: { Label("Start work", systemImage: "arrow.branch") }
                        }
                    }
            }
```
- Update the `BoardView.init` signature to `init(board:onMove:onStartWork:)` (both closures default nil), and pass `onStartWork` into each `ColumnView(column:onMove:onStartWork:)`.

- [ ] **Step 2: Wire in ContentView**

In `native/Apps/Shared/ContentView.swift`:
- Add `@StateObject private var branch = BranchModel()`.
- Add a computed handler (macOS supplies it, iOS nil so no menu item):
```swift
    private var startWorkHandler: ((Story) -> Void)? {
        #if os(macOS)
        return { story in branch.startWork(story: story, dir: model.storiesDirectory) }
        #else
        return nil
        #endif
    }
```
- In the `.loaded` case, pass it: `BoardView(board: board, onMove: { id, s in model.moveStory(id, to: s) }, onStartWork: startWorkHandler)`.
- Add a confirmation alert (distinct `isPresented`):
```swift
        .alert("Start work", isPresented: Binding(
            get: { branch.lastResult != nil },
            set: { if !$0 { branch.clear() } }
        )) {
            Button("OK", role: .cancel) { }
        } message: { Text(branch.lastResult ?? "") }
```
(`Story` is already in scope via `import SwrmCore`.)

- [ ] **Step 3: Build**
```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` both (iOS: `startWorkHandler` is nil → no menu item; `BranchModel` compiles via the iOS branch).

- [ ] **Step 4: Commit**
```bash
git add native/SwrmUI/Sources/SwrmUI/BoardView.swift native/Apps/Shared/ContentView.swift
git commit -m "feat(app): Start work context menu — create the story's branch (macOS)"
```

---

## Task 3: Verify
- [ ] `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )` → green.
- [ ] Both `xcodebuild` builds succeed.
- [ ] Manual (macOS): open a git-backed stories dir, right-click a card → "Start work" → `git rev-parse --abbrev-ref HEAD` shows `sc-<id>/<slug>` and the alert says "On …".

---

## Self-Review
- **Spec coverage:** create+switch branch / switch-if-exists (T1) · reuse `Story.branchName()` (T1 BranchModel) · macOS-only `GitBrancher` (T1) · injectable seam tests: calls brancher / nil-dir / throw (T1) · context-menu action (T2) · iOS no menu (T2 nil handler) · confirmation alert (T2). PR→done / branch delete out of scope.
- **Placeholders:** none.
- **Type consistency:** `GitBrancher().createOrSwitch(branch:in:)`, `GitBranchError`, `BranchModel(brancher:).startWork(story:dir:)` + `lastResult`/`clear()`, `Story.branchName()`, `BoardView(board:onMove:onStartWork:)`, `ColumnView(column:onMove:onStartWork:)` — consistent. (Note: `BoardView.init` gains a param — the existing `BoardView(board:onMove:)` call sites in ContentView are updated in T2; the `#Preview` uses `BoardView(board:)` which still works via defaults.)
```
