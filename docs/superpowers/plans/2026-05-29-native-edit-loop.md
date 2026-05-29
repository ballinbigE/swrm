# Native Edit Loop (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag a card between columns in the native macOS/iOS board to change its `state`, written straight back to the `.md` front-matter (surgical one-line edit), with an optimistic in-memory move and the live-watcher echo suppressed.

**Architecture:** Approach A. A pure-Foundation `StoryWriter` in SwrmCore does a surgical `state:`-line rewrite (preserves body/comments/unknown keys). `BoardModel.moveStory` updates the in-memory `Board` optimistically, writes the file, suppresses the next `FolderWatcher` reload, and reverts to `.error` on failure. `BoardView` gets `.draggable(story.id)` cards + `.dropDestination(for: String.self)` columns.

**Tech Stack:** Swift 6.3 (tools 5.9), SwiftPM (SwrmCore/SwrmUI), SwiftUI Transferable drag/drop (iOS 16 / macOS 13), XCTest, XcodeGen.

**Spec:** `docs/superpowers/specs/2026-05-29-native-edit-loop-design.md`

All paths relative to repo root `/Users/erickbzovi/Projects/swrm`.

---

## File Structure
**Create:**
- `native/SwrmCore/Sources/SwrmCore/StoryWriter.swift` — surgical `state:` write-back + file lookup by id.
- `native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift`
**Modify:**
- `native/SwrmUI/Sources/SwrmUI/BoardModel.swift` — `moveStory`, `suppressNextReload`, watcher-callback guard, `writer`.
- `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift` — move tests.
- `native/SwrmUI/Sources/SwrmUI/BoardView.swift` — draggable cards + drop-target columns + `onMove`.
- `native/Apps/Shared/ContentView.swift` — pass `onMove: { model.moveStory($0, to: $1) }` to `BoardView`.

---

## Task 1: StoryWriter (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/StoryWriter.swift`; Test `native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift`

- [ ] **Step 1: Write the failing test**

Create `native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift`:

```swift
import XCTest
@testable import SwrmCore

final class StoryWriterTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-writer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func write(_ name: String, _ text: String) throws -> URL {
        let u = dir.appendingPathComponent(name)
        try text.write(to: u, atomically: true, encoding: .utf8)
        return u
    }

    func testChangesOnlyStateLinePreservingEverythingElse() throws {
        let original = """
        ---
        id: sc-1
        type: feature
        state: backlog
        custom_key: keep-me
        labels: [ios, p1]
        ---
        Wire up the login screen
        - [ ] form
        """
        let url = try write("sc-1.md", original)
        try StoryWriter().setState(storyID: "sc-1", to: .started, in: dir)
        let after = try String(contentsOf: url, encoding: .utf8)
        let expected = original.replacingOccurrences(of: "state: backlog", with: "state: started")
        XCTAssertEqual(after, expected) // only the state line changed; custom_key + body intact
    }

    func testInsertsStateWhenMissing() throws {
        _ = try write("sc-2.md", "---\nid: sc-2\n---\nhi")
        try StoryWriter().setState(storyID: "sc-2", to: .done, in: dir)
        let s = try StoryParser().parse(String(contentsOf: dir.appendingPathComponent("sc-2.md"), encoding: .utf8))
        XCTAssertEqual(s.state, .done)
    }

    func testFindsFileByParsedIdWhenFilenameDiffers() throws {
        _ = try write("anything.md", "---\nid: sc-9\nstate: backlog\n---\nx")
        try StoryWriter().setState(storyID: "sc-9", to: .started, in: dir)
        let s = try StoryParser().parse(String(contentsOf: dir.appendingPathComponent("anything.md"), encoding: .utf8))
        XCTAssertEqual(s.state, .started)
    }

    func testThrowsNotFoundForUnknownID() {
        XCTAssertThrowsError(try StoryWriter().setState(storyID: "nope", to: .done, in: dir)) { err in
            XCTAssertEqual(err as? StoryWriteError, .notFound)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/SwrmCore && swift test --filter StoryWriterTests`
Expected: FAIL — `cannot find 'StoryWriter' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `native/SwrmCore/Sources/SwrmCore/StoryWriter.swift`:

```swift
import Foundation

public enum StoryWriteError: Error, Equatable {
    case notFound
}

/// Surgically rewrites a story's `state:` front-matter line in place, leaving the
/// rest of the file (body, comments, unknown keys, ordering) byte-identical.
/// Pure Foundation — no UI. Operates on `\n`-joined lines (CRLF is normalized to LF).
public struct StoryWriter {
    public init() {}

    public func setState(storyID: String, to newState: WorkflowState, in directory: URL) throws {
        let url = try fileURL(for: storyID, in: directory)
        let text = try String(contentsOf: url, encoding: .utf8)
        let updated = Self.replaceState(in: text, with: newState.rawValue)
        try updated.write(to: url, atomically: true, encoding: .utf8)
    }

    private func fileURL(for id: String, in dir: URL) throws -> URL {
        let direct = dir.appendingPathComponent("\(id).md")
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        let parser = StoryParser()
        for u in entries where u.pathExtension == "md" {
            if let text = try? String(contentsOf: u, encoding: .utf8),
               let s = try? parser.parse(text), s.id == id {
                return u
            }
        }
        throw StoryWriteError.notFound
    }

    /// Replace (or insert) the `state:` line inside the front-matter block only.
    static func replaceState(in text: String, with raw: String) -> String {
        var lines = text.components(separatedBy: "\n")
        guard let open = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
        else { return text }
        let rest = lines[(open + 1)...]
        guard let closeOffset = rest.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
        else { return text }
        let close = closeOffset // firstIndex on a slice returns an absolute index
        for i in (open + 1)..<close {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed == "state" || trimmed.hasPrefix("state:") || trimmed.hasPrefix("state ") {
                let indent = String(lines[i].prefix(while: { $0 == " " || $0 == "\t" }))
                lines[i] = "\(indent)state: \(raw)"
                return lines.joined(separator: "\n")
            }
        }
        lines.insert("state: \(raw)", at: open + 1)
        return lines.joined(separator: "\n")
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/SwrmCore && swift test --filter StoryWriterTests`
Expected: PASS (4 tests). Then full suite: `cd native/SwrmCore && swift test` — all green.

- [ ] **Step 5: Commit**

```bash
git add native/SwrmCore/Sources/SwrmCore/StoryWriter.swift native/SwrmCore/Tests/SwrmCoreTests/StoryWriterTests.swift
git commit -m "feat(core): StoryWriter — surgical state: front-matter write-back"
```

---

## Task 2: BoardModel.moveStory + echo-suppress (SwrmUI)

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`; Modify `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Write the failing tests**

Append to `BoardModelTests` (it already has `scratchDefaults()`, `makeStoriesDir`, `storiesCount`, `@MainActor`, temp-dir teardown):

```swift
    private func stateOf(_ state: LoadState, id: String) -> WorkflowState? {
        guard case let .loaded(board) = state else { return nil }
        return board.columns.flatMap { $0.stories }.first { $0.id == id }?.state
    }

    func testMoveStoryUpdatesBoardOptimisticallyAndPersists() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: backlog\n---\nWire login",
        ])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(stateOf(model.state, id: "sc-1"), .backlog)

        model.moveStory("sc-1", to: .started)
        XCTAssertEqual(stateOf(model.state, id: "sc-1"), .started) // optimistic

        // persisted on disk
        let reloaded = try StoryStore(directory: dir).load().first { $0.id == "sc-1" }
        XCTAssertEqual(reloaded?.state, .started)
    }

    func testMoveToSameColumnIsNoOp() throws {
        let dir = try makeStoriesDir(["---\nid: sc-1\nstate: started\n---\nx"])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        model.moveStory("sc-1", to: .started)
        XCTAssertEqual(stateOf(model.state, id: "sc-1"), .started)
    }

    func testMoveFailureRevertsToError() throws {
        let dir = try makeStoriesDir(["---\nid: sc-1\nstate: backlog\n---\nx"])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        // delete the file out from under it so the surgical write throws .notFound
        try FileManager.default.removeItem(at: dir.appendingPathComponent("sc-1.md"))
        model.moveStory("sc-1", to: .done)
        if case .error = model.state { } else { XCTFail("expected .error, got \(model.state)") }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `value of type 'BoardModel' has no member 'moveStory'`.

- [ ] **Step 3: Implement moveStory + suppress flag**

In `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`:

(a) Add two stored properties near `scopedURL` (after line ~34):

```swift
    private let writer = StoryWriter()
    private var suppressNextReload = false
```

(b) Replace the watcher closure inside `startWatching(_:)` so it honors the suppress flag:

```swift
    private func startWatching(_ dir: URL) {
        let w = FolderWatcher(url: dir) { [weak self] in
            guard let self, let d = self.currentStoriesDir else { return }
            if self.suppressNextReload { self.suppressNextReload = false; return }
            self.reload(storiesDir: d)
        }
        watcher = w
        w.start()
    }
```

(c) Add the public method (place after `refresh()`):

```swift
    /// Move a story to a new column (changes its `state`), written back to disk.
    /// Optimistic with revert-to-error on write failure; the resulting self-write
    /// reload is suppressed once so the board doesn't flicker.
    public func moveStory(_ id: String, to newState: WorkflowState) {
        guard case let .loaded(board) = state, let dir = currentStoriesDir else { return }
        var all = board.columns.flatMap { $0.stories }
        guard let idx = all.firstIndex(where: { $0.id == id }) else { return }
        if all[idx].state == newState { return }

        all[idx].state = newState
        state = .loaded(Board(stories: all))   // optimistic
        suppressNextReload = true
        do {
            try writer.setState(storyID: id, to: newState, in: dir)
        } catch {
            suppressNextReload = false
            state = .error("Couldn't save move")
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: PASS (existing + 3 new). Then `cd native/SwrmUI && swift test` — all green.

- [ ] **Step 5: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): BoardModel.moveStory — optimistic drag-to-move + echo-suppress"
```

---

## Task 3: Draggable board (SwrmUI BoardView + ContentView)

UI glue — verified by building the apps in Task 4 (SwiftUI drag isn't unit-testable).

**Files:** Modify `native/SwrmUI/Sources/SwrmUI/BoardView.swift`; Modify `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Add onMove + drag/drop to BoardView**

Replace the top of `native/SwrmUI/Sources/SwrmUI/BoardView.swift` (the `BoardView` and `ColumnView` structs) with — note `String` is `Transferable`, so the dragged payload is just the story id:

```swift
import SwiftUI
import SwrmCore

/// The whole board: horizontally-scrolling workflow-state columns.
/// `onMove(storyID, newState)` is called when a card is dropped on a column;
/// pass nil for a read-only board (e.g. previews).
public struct BoardView: View {
    public let board: Board
    public var onMove: ((String, WorkflowState) -> Void)?

    public init(board: Board, onMove: ((String, WorkflowState) -> Void)? = nil) {
        self.board = board
        self.onMove = onMove
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(board.columns, id: \.state) { column in
                    ColumnView(column: column, onMove: onMove)
                }
            }
            .padding(16)
        }
        .background(SwrmTheme.charcoal.ignoresSafeArea())
    }
}

struct ColumnView: View {
    let column: BoardColumn
    var onMove: ((String, WorkflowState) -> Void)?
    @State private var targeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(column.state.title)
                    .font(.headline)
                    .foregroundColor(SwrmTheme.cream)
                Spacer()
                Text("\(column.stories.count)")
                    .font(.subheadline)
                    .foregroundColor(SwrmTheme.muted)
            }
            ForEach(column.stories, id: \.id) { story in
                StoryCardView(story: story)
                    .draggable(story.id)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(width: 260, alignment: .topLeading)
        .background(SwrmTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(column.state.accent.opacity(targeted ? 0.9 : 0.4),
                        lineWidth: targeted ? 2 : 1)
        )
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, let onMove else { return false }
            onMove(id, column.state)
            return true
        } isTargeted: { targeted = $0 }
    }
}
```

(Leave `StoryCardView` below unchanged.)

- [ ] **Step 2: Wire onMove in ContentView**

In `native/Apps/Shared/ContentView.swift`, find the `.loaded` case rendering `BoardView(board: board)` and change it to:

```swift
        case .loaded(let board):
            BoardView(board: board, onMove: { id, newState in model.moveStory(id, to: newState) })
```

(Leave the `#Preview { BoardView(board: SampleData.board) }` as-is — it stays read-only with `onMove` defaulting to nil.)

- [ ] **Step 3: Build both apps**

```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` for both. (If the iOS destination is rejected, `xcrun simctl list devices available` and use a concrete `-destination 'platform=iOS Simulator,name=<device>'`.)

- [ ] **Step 4: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardView.swift native/Apps/Shared/ContentView.swift
git commit -m "feat(app): drag-to-move board — draggable cards + drop-target columns"
```

---

## Task 4: Full verification

**Files:** none.

- [ ] **Step 1: Both Swift suites**

Run: `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )`
Expected: both PASS, 0 failures (SwrmCore = prior + StoryWriter's 4; SwrmUI = prior + 3 move tests).

- [ ] **Step 2: Manual smoke (macOS, recommended)**

Build & run SwrmMac (Xcode Run or the built `.app`), Open Folder → `native/sample/stories`, then:
- Drag `sc-3` (Backlog) into **In Progress** → it moves; column counts update; the drop target highlights while dragging.
- Confirm on disk: `grep state native/sample/stories/sc-3.md` now shows `state: started` (and the rest of the file is unchanged).
- Confirm the board does **not** flicker/double-update from the watcher echo.

- [ ] **Step 3: Final commit (only if smoke surfaced fixes)**

```bash
git add -A && git commit -m "chore: Slice B verification fixes"
```

---

## Self-Review
- **Spec coverage:** surgical `state:` write (T1) · file lookup by id incl. filename-mismatch (T1) · `.notFound` (T1) · optimistic move (T2) · persist (T2) · same-column no-op (T2) · write-failure → `.error` (T2) · echo-suppress one reload (T2 watcher guard) · keeps `rank` (Board re-derives from the moved story's unchanged rank; no rank touched) · `.draggable`/`.dropDestination` both platforms (T3) · drop highlight (T3 `isTargeted`). Out-of-scope items (field edit/create/delete/reorder/git) intentionally absent.
- **Placeholders:** none — full code in every step.
- **Type consistency:** `StoryWriter().setState(storyID:to:in:)`, `StoryWriteError.notFound`, `BoardModel.moveStory(_:to:)`, `suppressNextReload`, `writer`, `BoardView(board:onMove:)`, `ColumnView(column:onMove:)`, `WorkflowState` cases — all consistent across tasks and match the current code (`@MainActor BoardModel`, `state: LoadState`, `currentStoriesDir`, `startWatching`).
