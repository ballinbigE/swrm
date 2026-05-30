# Native Git-Backed Moves (Slice C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every drag-to-move on the native board (macOS) also makes one clean git commit of the changed `.md` file — message `"<id>: <old> → <new>"`. Best-effort: commit failure never reverts the move. iOS writes the file only (no git).

**Architecture:** A macOS-only `GitCommitter` in SwrmCore shells out to `/usr/bin/git` via `Process`. `StoryWriter.setState` now returns the written file URL. `BoardModel.moveStory` fires a detached, swallow-on-failure commit after the write (guarded `#if os(macOS)`).

**Tech Stack:** Swift 6.3, SwiftPM, Foundation `Process`, XCTest, git.

**Spec:** `docs/superpowers/specs/2026-05-29-native-git-backed-moves-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: GitCommitter + StoryWriter returns URL (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/GitCommitter.swift`; Modify `native/SwrmCore/Sources/SwrmCore/StoryWriter.swift`; Create `native/SwrmCore/Tests/SwrmCoreTests/GitCommitterTests.swift`; Modify `native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift`

- [ ] **Step 1: Write the failing GitCommitter test**

Create `native/SwrmCore/Tests/SwrmCoreTests/GitCommitterTests.swift`:

```swift
#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitCommitterTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-git-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    @discardableResult
    private func git(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run(); p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    private func initRepo() throws -> URL {
        try git(["init"])
        try git(["config", "user.email", "t@t.test"])
        try git(["config", "user.name", "Tester"])
        let file = dir.appendingPathComponent("sc-1.md")
        try "---\nid: sc-1\nstate: backlog\n---\nx".write(to: file, atomically: true, encoding: .utf8)
        try git(["add", "-A"]); try git(["commit", "-m", "init"])
        return file
    }

    func testCommitsAChangedFileAndReturnsSha() throws {
        let file = try initRepo()
        try "---\nid: sc-1\nstate: started\n---\nx".write(to: file, atomically: true, encoding: .utf8)
        let sha = try GitCommitter().commit(file: file, message: "sc-1: backlog → started")
        XCTAssertFalse(sha.isEmpty)
        let subject = try git(["log", "-1", "--format=%s"]).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(subject, "sc-1: backlog → started")
    }

    func testUnchangedFileIsNoOp() throws {
        let file = try initRepo()
        // no modification → "nothing to commit" must not throw
        XCTAssertNoThrow(try GitCommitter().commit(file: file, message: "noop"))
    }

    func testNonRepoThrowsNotARepo() throws {
        let file = dir.appendingPathComponent("loose.md")
        try "hi".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try GitCommitter().commit(file: file, message: "x")) { err in
            XCTAssertEqual(err as? GitError, .notARepo)
        }
    }
}
#endif
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd native/SwrmCore && swift test --filter GitCommitterTests`
Expected: FAIL — `cannot find 'GitCommitter' in scope`.

- [ ] **Step 3: Implement GitCommitter**

Create `native/SwrmCore/Sources/SwrmCore/GitCommitter.swift`:

```swift
#if os(macOS)
import Foundation

public enum GitError: Error, Equatable {
    case notARepo
    case failed(String)
}

/// Stages + commits a single file in its git repo by shelling out to `git`.
/// macOS only — iOS has no git binary / `Process`. Foundation-only, no UI.
public struct GitCommitter {
    public init() {}

    /// Commit just `file` with `message`. Returns the new HEAD sha.
    /// No-op (returns current HEAD) when there is nothing to commit.
    @discardableResult
    public func commit(file: URL, message: String) throws -> String {
        let fileDir = file.deletingLastPathComponent()
        let top = try run(["rev-parse", "--show-toplevel"], inDir: fileDir)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !top.isEmpty else { throw GitError.notARepo }
        let repo = URL(fileURLWithPath: top)

        _ = try run(["add", "--", file.path], inDir: repo)
        do {
            _ = try run(["commit", "-m", message, "--", file.path], inDir: repo)
        } catch let GitError.failed(out) where out.contains("nothing to commit") {
            // unchanged / already committed — fine
        }
        return try run(["rev-parse", "HEAD"], inDir: repo)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    private func run(_ args: [String], inDir dir: URL) throws -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = ["-C", dir.path] + args
        let out = Pipe(); let err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        do { try proc.run() } catch { throw GitError.failed("\(error)") }
        proc.waitUntilExit()
        let outStr = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errStr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if proc.terminationStatus != 0 {
            if errStr.contains("not a git repository") { throw GitError.notARepo }
            throw GitError.failed(outStr + errStr)
        }
        return outStr
    }
}
#endif
```

- [ ] **Step 4: Make StoryWriter.setState return the URL**

In `native/SwrmCore/Sources/SwrmCore/StoryWriter.swift`, change the `setState` signature + add the return:

```swift
    @discardableResult
    public func setState(storyID: String, to newState: WorkflowState, in directory: URL) throws -> URL {
        let url = try fileURL(for: storyID, in: directory)
        let text = try String(contentsOf: url, encoding: .utf8)
        let updated = Self.replaceState(in: text, with: newState.rawValue)
        try updated.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
```

Add an assertion to `native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift` (inside `testChangesOnlyStateLinePreservingEverythingElse`, after the write call):

```swift
        let returned = try StoryWriter().setState(storyID: "sc-1", to: .started, in: dir)
        XCTAssertEqual(returned.lastPathComponent, "sc-1.md")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd native/SwrmCore && swift test`
Expected: PASS — prior 28 + GitCommitter (3) + the StoryWriter return assertion (still within its test).

- [ ] **Step 6: Commit**

```bash
git add native/SwrmCore/Sources/SwrmCore/GitCommitter.swift native/SwrmCore/Sources/SwrmCore/StoryWriter.swift native/SwrmCore/Tests/SwrmCoreTests/GitCommitterTests.swift native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift
git commit -m "feat(core): GitCommitter — one clean commit per file; StoryWriter returns URL"
```

---

## Task 2: BoardModel commits on move (SwrmUI)

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`; Modify `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Write the failing integration test**

Append to `BoardModelTests` (macOS-guarded — git is the host):

```swift
#if os(macOS)
    @discardableResult
    private func runGit(_ args: [String], in dir: URL) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    func testMoveCommitsInGitRepo() throws {
        let dir = try makeStoriesDir(["---\nid: sc-1\nstate: backlog\n---\nx"])
        runGit(["init"], in: dir)
        runGit(["config", "user.email", "t@t.test"], in: dir)
        runGit(["config", "user.name", "Tester"], in: dir)
        runGit(["add", "-A"], in: dir); runGit(["commit", "-m", "init"], in: dir)

        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        model.moveStory("sc-1", to: .started)

        // commit is fired in a detached Task — poll the log briefly
        var subject = ""
        for _ in 0..<50 {
            subject = runGit(["log", "-1", "--format=%s"], in: dir).trimmingCharacters(in: .whitespacesAndNewlines)
            if subject == "sc-1: backlog → started" { break }
            usleep(100_000)
        }
        XCTAssertEqual(subject, "sc-1: backlog → started")
    }
#endif

    func testMoveInNonGitDirStillSucceeds() throws {
        let dir = try makeStoriesDir(["---\nid: sc-1\nstate: backlog\n---\nx"])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        model.moveStory("sc-1", to: .done)
        XCTAssertEqual(stateOf(model.state, id: "sc-1"), .done) // no git, move still works
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `testMoveCommitsInGitRepo` never finds the commit (no commit hook yet).

- [ ] **Step 3: Add the commit hook to moveStory**

Replace `moveStory` in `native/SwrmUI/Sources/SwrmUI/BoardModel.swift` with:

```swift
    /// Move a story to a new column (changes its `state`), written back to disk and,
    /// on macOS in a git repo, committed (best-effort). Optimistic with revert-to-error
    /// on write failure; commit failures are swallowed (the file is the source of truth).
    public func moveStory(_ id: String, to newState: WorkflowState) {
        guard case let .loaded(board) = state, let dir = currentStoriesDir else { return }
        var all = board.columns.flatMap { $0.stories }
        guard let idx = all.firstIndex(where: { $0.id == id }) else { return }
        let oldState = all[idx].state
        if oldState == newState { return }

        all[idx].state = newState
        state = .loaded(Board(stories: all))   // optimistic
        suppressNextReload = true
        do {
            let fileURL = try writer.setState(storyID: id, to: newState, in: dir)
            #if os(macOS)
            let message = "\(id): \(oldState.rawValue) → \(newState.rawValue)"
            Task.detached { _ = try? GitCommitter().commit(file: fileURL, message: message) }
            #endif
        } catch {
            suppressNextReload = false
            state = .error("Couldn't save move")
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd native/SwrmUI && swift test`
Expected: PASS — prior 15 + `testMoveCommitsInGitRepo` + `testMoveInNonGitDirStillSucceeds`.

- [ ] **Step 5: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): commit each card move to git (macOS, best-effort, async)"
```

---

## Task 3: Build both apps + verify

- [ ] **Step 1: Both suites**

Run: `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )`
Expected: both PASS, 0 failures.

- [ ] **Step 2: Build mac + iOS** (iOS must compile with the `#if os(macOS)` git path excluded)

```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` for both.

- [ ] **Step 3: Manual smoke (optional)**

In a git-backed stories dir, run SwrmMac, drag a card → `git log -1` shows `"<id>: old → new"`.

---

## Self-Review
- **Spec coverage:** commit-on-move (T2) · message format `id: old → new` (T1/T2) · macOS-only via `#if os(macOS)` (T1 file + T2 hook) · best-effort swallow incl. not-a-repo + nothing-to-commit (T1) · async detached (T2) · `StoryWriter` returns URL (T1) · move still works without git (T2) · iOS compiles (T3 iOS build). Branch convention / PR / CI intentionally absent.
- **Placeholders:** none.
- **Type consistency:** `GitCommitter().commit(file:message:) -> String`, `GitError.notARepo`/`.failed`, `StoryWriter.setState(...) -> URL`, `BoardModel.moveStory(_:to:)`, `suppressNextReload`, `writer` — consistent across tasks and with the current code.
