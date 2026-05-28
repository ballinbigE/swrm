# Native Real Local Board (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The native macOS + iOS app lets a person pick a folder, loads real `.swrm/stories/*.md` files, renders them read-only on the existing `BoardView`, and live-refreshes when files change on disk.

**Architecture:** Three-layer split (Approach A). Pure Foundation infra (`StoriesLocator`, `BookmarkStore`, `FolderWatcher`) lives in `SwrmCore` and is unit-tested. An `ObservableObject` `BoardModel` in `SwrmUI` composes them into a published `LoadState`. Only the platform folder *picker* lives in `Apps/Shared`. No event store — Slice A is a read-only projection (see Event Modeling blueprint in the spec).

**Tech Stack:** Swift 6.3 (tools 5.9), SwiftPM (`SwrmCore`, `SwrmUI`), SwiftUI + Combine, XcodeGen (`native/project.yml`), XCTest. Targets macOS 13 / iOS 16.

**Spec:** `docs/superpowers/specs/2026-05-28-native-real-local-board-design.md`

### Deliberate refinements vs the spec (decided while planning)

1. **Plain bookmarks, not `.withSecurityScope`, in Slice A.** The macOS app stays **non-sandboxed** for local dogfooding, so `BookmarkStore` uses default bookmark options on both platforms. `.withSecurityScope` + sandbox entitlements are deferred to the distribution slice (and would otherwise make the unit test fail in a non-sandboxed `swift test` process). iOS document-picker URLs still resolve with default options.
2. **No entitlement files / no `project.yml` signing changes** for Slice A (follows from #1).
3. **`error` triggers on a directory existence/readability check**, not on `startAccessingSecurityScopedResource()` returning `false` (that bool is `false` for ordinary non-scoped URLs and is not an error). `startAccessing` is still called/balanced for iOS scoped URLs.

All paths below are relative to the repo root `/Users/erickbzovi/Projects/swrm`.

---

## File Structure

**Created:**
- `native/SwrmCore/Sources/SwrmCore/StoriesLocator.swift` — resolve picked folder → stories dir.
- `native/SwrmCore/Sources/SwrmCore/BookmarkStore.swift` — persist/resolve last folder (UserDefaults bookmark).
- `native/SwrmCore/Sources/SwrmCore/FolderWatcher.swift` — DispatchSource directory watcher.
- `native/SwrmCore/Tests/SwrmCoreTests/StoriesLocatorTests.swift`
- `native/SwrmCore/Tests/SwrmCoreTests/BookmarkStoreTests.swift`
- `native/SwrmCore/Tests/SwrmCoreTests/FolderWatcherTests.swift`
- `native/SwrmUI/Sources/SwrmUI/BoardModel.swift` — `LoadState` + `BoardModel` (ObservableObject).
- `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`
- `native/Apps/Shared/FolderPicker.swift` — `FolderPickerButton` (`#if os` NSOpenPanel / UIDocumentPicker).

**Modified:**
- `native/SwrmUI/Package.swift` — add `SwrmUITests` test target.
- `native/Apps/Shared/ContentView.swift` — replace `SampleData` with `BoardModel`-driven states.

**Untouched (relied upon):** `Story.swift`, `Board.swift`, `StoryParser.swift`, `StoryStore.swift`, `BoardView.swift`, `Theme.swift`, `SampleData.swift` (kept for previews), `SwrmApp.swift`, `project.yml`.

---

## Task 1: StoriesLocator (SwrmCore)

**Files:**
- Create: `native/SwrmCore/Sources/SwrmCore/StoriesLocator.swift`
- Test: `native/SwrmCore/Tests/SwrmCoreTests/StoriesLocatorTests.swift`

- [ ] **Step 1: Write the failing test**

Create `native/SwrmCore/Tests/SwrmCoreTests/StoriesLocatorTests.swift`:

```swift
import XCTest
@testable import SwrmCore

final class StoriesLocatorTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-locator-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testReturnsSwrmStoriesWhenPresent() throws {
        let stories = root
            .appendingPathComponent(".swrm", isDirectory: true)
            .appendingPathComponent("stories", isDirectory: true)
        try FileManager.default.createDirectory(at: stories, withIntermediateDirectories: true)

        let resolved = StoriesLocator().resolve(pickedFolder: root)
        XCTAssertEqual(resolved.standardizedFileURL, stories.standardizedFileURL)
    }

    func testReturnsPickedFolderWhenNoSwrmStories() {
        let resolved = StoriesLocator().resolve(pickedFolder: root)
        XCTAssertEqual(resolved.standardizedFileURL, root.standardizedFileURL)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/SwrmCore && swift test --filter StoriesLocatorTests`
Expected: FAIL — compile error, `cannot find 'StoriesLocator' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `native/SwrmCore/Sources/SwrmCore/StoriesLocator.swift`:

```swift
import Foundation

/// Resolves the directory that actually holds story `.md` files for a picked
/// folder. If `<picked>/.swrm/stories/` exists as a directory, that is the
/// stories dir; otherwise the picked folder itself is treated as the stories dir.
public struct StoriesLocator {
    public init() {}

    public func resolve(pickedFolder: URL) -> URL {
        let candidate = pickedFolder
            .appendingPathComponent(".swrm", isDirectory: true)
            .appendingPathComponent("stories", isDirectory: true)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir),
           isDir.boolValue {
            return candidate
        }
        return pickedFolder
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/SwrmCore && swift test --filter StoriesLocatorTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add native/SwrmCore/Sources/SwrmCore/StoriesLocator.swift native/SwrmCore/Tests/SwrmCoreTests/StoriesLocatorTests.swift
git commit -m "feat(core): StoriesLocator — resolve .swrm/stories else picked dir"
```

---

## Task 2: BookmarkStore (SwrmCore)

**Files:**
- Create: `native/SwrmCore/Sources/SwrmCore/BookmarkStore.swift`
- Test: `native/SwrmCore/Tests/SwrmCoreTests/BookmarkStoreTests.swift`

- [ ] **Step 1: Write the failing test**

Create `native/SwrmCore/Tests/SwrmCoreTests/BookmarkStoreTests.swift`:

```swift
import XCTest
@testable import SwrmCore

final class BookmarkStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var dir: URL!

    override func setUpWithError() throws {
        suiteName = "swrm.test.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-bm-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testResolveIsNilWhenNothingSaved() {
        XCTAssertNil(BookmarkStore(defaults: defaults).resolve())
    }

    func testSaveThenResolveRoundTrip() {
        let store = BookmarkStore(defaults: defaults)
        store.save(dir)
        let resolved = store.resolve()
        XCTAssertEqual(resolved?.resolvingSymlinksInPath().path,
                       dir.resolvingSymlinksInPath().path)
    }

    func testClearRemovesBookmark() {
        let store = BookmarkStore(defaults: defaults)
        store.save(dir)
        store.clear()
        XCTAssertNil(store.resolve())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/SwrmCore && swift test --filter BookmarkStoreTests`
Expected: FAIL — `cannot find 'BookmarkStore' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `native/SwrmCore/Sources/SwrmCore/BookmarkStore.swift`:

```swift
import Foundation

/// Persists a bookmark to the last-opened folder so it survives relaunches.
/// Foundation-only. Slice A uses default (plain) bookmark options because the
/// macOS app is non-sandboxed; `.withSecurityScope` + sandbox entitlements are
/// deferred to the distribution slice.
public struct BookmarkStore {
    private let defaults: UserDefaults
    private let key = "swrm.lastFolderBookmark"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func save(_ url: URL) {
        if let data = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) {
            defaults.set(data, forKey: key)
        }
    }

    public func resolve() -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        if stale {
            defaults.removeObject(forKey: key)
            return nil
        }
        return url
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/SwrmCore && swift test --filter BookmarkStoreTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add native/SwrmCore/Sources/SwrmCore/BookmarkStore.swift native/SwrmCore/Tests/SwrmCoreTests/BookmarkStoreTests.swift
git commit -m "feat(core): BookmarkStore — persist/resolve last folder via UserDefaults"
```

---

## Task 3: FolderWatcher (SwrmCore)

**Files:**
- Create: `native/SwrmCore/Sources/SwrmCore/FolderWatcher.swift`
- Test: `native/SwrmCore/Tests/SwrmCoreTests/FolderWatcherTests.swift`

- [ ] **Step 1: Write the failing test**

Create `native/SwrmCore/Tests/SwrmCoreTests/FolderWatcherTests.swift`:

```swift
import XCTest
@testable import SwrmCore

final class FolderWatcherTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-watch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testFiresOnChangeWhenFileAdded() {
        let expectation = expectation(description: "onChange fires")
        let watcher = FolderWatcher(url: dir, debounceInterval: 0.05) {
            expectation.fulfill()
        }
        watcher.start()
        defer { watcher.stop() }

        // Give the source a moment to arm, then mutate the directory.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
            let file = self.dir.appendingPathComponent("sc-1.md")
            try? "---\nid: sc-1\n---\nhi".write(to: file, atomically: true, encoding: .utf8)
        }

        wait(for: [expectation], timeout: 5.0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd native/SwrmCore && swift test --filter FolderWatcherTests`
Expected: FAIL — `cannot find 'FolderWatcher' in scope`.

- [ ] **Step 3: Write minimal implementation**

Create `native/SwrmCore/Sources/SwrmCore/FolderWatcher.swift`:

```swift
import Foundation

/// Watches a directory for content changes via a DispatchSource on its file
/// descriptor. Coalesces bursts (debounce) and invokes `onChange` on the main
/// queue. Pure Foundation — works cross-platform and under `swift test`.
public final class FolderWatcher {
    private let url: URL
    private let onChange: () -> Void
    private let debounceInterval: TimeInterval
    private let queue = DispatchQueue(label: "swrm.folderwatcher")
    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: Int32 = -1
    private var debounceWork: DispatchWorkItem?

    public init(url: URL, debounceInterval: TimeInterval = 0.2, onChange: @escaping () -> Void) {
        self.url = url
        self.debounceInterval = debounceInterval
        self.onChange = onChange
    }

    deinit { stop() }

    public func start() {
        stop()
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        fileDescriptor = fd
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .extend],
            queue: queue
        )
        src.setEventHandler { [weak self] in self?.scheduleChange() }
        src.setCancelHandler { [weak self] in
            if let fd = self?.fileDescriptor, fd >= 0 { close(fd) }
            self?.fileDescriptor = -1
        }
        source = src
        src.resume()
    }

    public func stop() {
        debounceWork?.cancel()
        debounceWork = nil
        source?.cancel()
        source = nil
    }

    private func scheduleChange() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            DispatchQueue.main.async { self?.onChange() }
        }
        debounceWork = work
        queue.asyncAfter(deadline: .now() + debounceInterval, execute: work)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd native/SwrmCore && swift test --filter FolderWatcherTests`
Expected: PASS (1 test). If flaky on a loaded machine, the 5s timeout is generous; re-run.

- [ ] **Step 5: Run the whole core suite**

Run: `cd native/SwrmCore && swift test`
Expected: PASS — existing `SwrmCoreTests` (8) + StoriesLocator (2) + BookmarkStore (3) + FolderWatcher (1).

- [ ] **Step 6: Commit**

```bash
git add native/SwrmCore/Sources/SwrmCore/FolderWatcher.swift native/SwrmCore/Tests/SwrmCoreTests/FolderWatcherTests.swift
git commit -m "feat(core): FolderWatcher — debounced DispatchSource directory watcher"
```

---

## Task 4: SwrmUITests target + BoardModel skeleton (SwrmUI)

**Files:**
- Modify: `native/SwrmUI/Package.swift`
- Create: `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`
- Test: `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Add the test target to the package**

Replace the entire contents of `native/SwrmUI/Package.swift` with:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SwrmUI",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "SwrmUI", targets: ["SwrmUI"]),
    ],
    dependencies: [
        .package(path: "../SwrmCore"),
    ],
    targets: [
        .target(name: "SwrmUI", dependencies: ["SwrmCore"]),
        .testTarget(name: "SwrmUITests", dependencies: ["SwrmUI"]),
    ]
)
```

- [ ] **Step 2: Write the failing test**

Create `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`:

```swift
import XCTest
@testable import SwrmUI
import SwrmCore

final class BoardModelTests: XCTestCase {
    func testInitialStateIsIdle() {
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        XCTAssertEqual(model.state, .idle)
    }

    // MARK: helpers (used by later tasks too)

    static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "swrm.uitest.\(UUID().uuidString)")!
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `cannot find 'BoardModel' in scope`.

- [ ] **Step 4: Write minimal implementation**

Create `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

/// What the board UI is currently showing.
public enum LoadState: Equatable {
    case idle
    case loading
    case loaded(Board)
    case empty
    case error(String)
}

/// Owns the selected folder, loads/derives the board, and live-refreshes it as
/// the underlying `.swrm/stories/*.md` files change. Read-only (Slice A).
public final class BoardModel: ObservableObject {
    @Published public private(set) var state: LoadState = .idle
    @Published public private(set) var folderName: String?

    private let bookmarkStore: BookmarkStore
    private let locator = StoriesLocator()

    public init(bookmarkStore: BookmarkStore = BookmarkStore()) {
        self.bookmarkStore = bookmarkStore
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add native/SwrmUI/Package.swift native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): BoardModel skeleton + LoadState + SwrmUITests target"
```

---

## Task 5: BoardModel.openFolder loads / empties / errors (SwrmUI)

**Files:**
- Modify: `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`
- Modify: `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Add a fixture helper + failing tests**

Add these to `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift` (inside the class; keep `scratchDefaults()`):

```swift
    func makeStoriesDir(_ markdown: [String]) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-board-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (i, md) in markdown.enumerated() {
            try md.write(to: dir.appendingPathComponent("sc-\(i + 1).md"),
                         atomically: true, encoding: .utf8)
        }
        return dir
    }

    private func storiesCount(_ state: LoadState) -> Int {
        guard case let .loaded(board) = state else { return -1 }
        return board.columns.reduce(0) { $0 + $1.stories.count }
    }

    func testOpenFolderLoadsBoard() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
            "---\nid: sc-2\nstate: backlog\n---\nBump deps",
        ])
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(storiesCount(model.state), 2)
        XCTAssertEqual(model.folderName, dir.lastPathComponent)
    }

    func testOpenEmptyFolderIsEmptyState() throws {
        let dir = try makeStoriesDir([])
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(model.state, .empty)
    }

    func testOpenMissingFolderIsErrorState() {
        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-missing-\(UUID().uuidString)", isDirectory: true)
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.openFolder(missing)
        if case .error = model.state { } else { XCTFail("expected .error, got \(model.state)") }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `value of type 'BoardModel' has no member 'openFolder'`.

- [ ] **Step 3: Implement openFolder + load**

Replace the entire contents of `native/SwrmUI/Sources/SwrmUI/BoardModel.swift` with:

```swift
import Foundation
import Combine
import SwrmCore

/// What the board UI is currently showing.
public enum LoadState: Equatable {
    case idle
    case loading
    case loaded(Board)
    case empty
    case error(String)
}

/// Owns the selected folder, loads/derives the board, and live-refreshes it as
/// the underlying `.swrm/stories/*.md` files change. Read-only (Slice A).
public final class BoardModel: ObservableObject {
    @Published public private(set) var state: LoadState = .idle
    @Published public private(set) var folderName: String?

    private let bookmarkStore: BookmarkStore
    private let locator = StoriesLocator()
    private var watcher: FolderWatcher?
    private var currentStoriesDir: URL?
    private var scopedURL: URL?

    public init(bookmarkStore: BookmarkStore = BookmarkStore()) {
        self.bookmarkStore = bookmarkStore
    }

    deinit {
        watcher?.stop()
        scopedURL?.stopAccessingSecurityScopedResource()
    }

    /// Open a folder the user picked (persists it for next launch).
    public func openFolder(_ url: URL) {
        present(pickedFolder: url, saveBookmark: true)
    }

    private func present(pickedFolder: URL, saveBookmark: Bool) {
        // Release any previously-open folder.
        watcher?.stop(); watcher = nil
        scopedURL?.stopAccessingSecurityScopedResource(); scopedURL = nil

        // Needed for iOS document-picker URLs; harmless `false` for plain URLs.
        if pickedFolder.startAccessingSecurityScopedResource() {
            scopedURL = pickedFolder
        }
        if saveBookmark { bookmarkStore.save(pickedFolder) }

        let storiesDir = locator.resolve(pickedFolder: pickedFolder)
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: storiesDir.path, isDirectory: &isDir)
        guard exists, isDir.boolValue,
              FileManager.default.isReadableFile(atPath: storiesDir.path) else {
            state = .error("Couldn't read folder. Re-open it.")
            return
        }

        folderName = pickedFolder.lastPathComponent
        currentStoriesDir = storiesDir
        state = .loading
        reload(storiesDir: storiesDir)
    }

    private func reload(storiesDir: URL) {
        let stories = (try? StoryStore(directory: storiesDir).load()) ?? []
        let board = Board(stories: stories)
        let isEmpty = board.columns.allSatisfy { $0.stories.isEmpty }
        let next: LoadState = isEmpty ? .empty : .loaded(board)
        if next != state { state = next }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: PASS (4 tests: idle, load, empty, error).

- [ ] **Step 5: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): BoardModel.openFolder — load board / empty / error states"
```

---

## Task 6: BoardModel.restoreLastFolder (SwrmUI)

**Files:**
- Modify: `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`
- Modify: `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Write failing tests**

Add to `BoardModelTests`:

```swift
    func testRestoreWithNoBookmarkIsIdle() {
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.restoreLastFolder()
        XCTAssertEqual(model.state, .idle)
    }

    func testRestoreReopensSavedFolder() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let defaults = Self.scratchDefaults()

        // First launch: open + persist.
        let first = BoardModel(bookmarkStore: BookmarkStore(defaults: defaults))
        first.openFolder(dir)
        XCTAssertEqual(storiesCount(first.state), 1)

        // Second launch: a fresh model restores from the same store.
        let second = BoardModel(bookmarkStore: BookmarkStore(defaults: defaults))
        second.restoreLastFolder()
        XCTAssertEqual(storiesCount(second.state), 1)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `value of type 'BoardModel' has no member 'restoreLastFolder'`.

- [ ] **Step 3: Implement restoreLastFolder**

In `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`, add this method directly after `openFolder(_:)`:

```swift
    /// Re-open the folder saved on a previous launch, if any.
    public func restoreLastFolder() {
        guard let url = bookmarkStore.resolve() else {
            state = .idle
            return
        }
        present(pickedFolder: url, saveBookmark: false)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): BoardModel.restoreLastFolder — reopen saved folder on launch"
```

---

## Task 7: BoardModel live-watch + refresh (SwrmUI)

**Files:**
- Modify: `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`
- Modify: `native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift`

- [ ] **Step 1: Write failing tests**

Add to `BoardModelTests` (add `import Combine` to the file's imports if not present):

```swift
    func testRefreshPicksUpNewlyEmptiedFolder() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(storiesCount(model.state), 1)

        try FileManager.default.removeItem(at: dir.appendingPathComponent("sc-1.md"))
        model.refresh()
        XCTAssertEqual(model.state, .empty)
    }

    func testWatcherReloadsWhenFileAdded() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)

        let expectation = expectation(description: "board grows to 2 stories")
        var cancellable: AnyCancellable?
        cancellable = model.$state.sink { state in
            if case let .loaded(board) = state,
               board.columns.reduce(0, { $0 + $1.stories.count }) == 2 {
                expectation.fulfill()
            }
        }

        // Add a second story file; the watcher should reload.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) {
            let f = dir.appendingPathComponent("sc-2.md")
            try? "---\nid: sc-2\nstate: backlog\n---\nBump deps"
                .write(to: f, atomically: true, encoding: .utf8)
        }

        wait(for: [expectation], timeout: 5.0)
        cancellable?.cancel()
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: FAIL — `value of type 'BoardModel' has no member 'refresh'`, and the watcher test never fulfills.

- [ ] **Step 3: Implement refresh + watcher wiring**

In `native/SwrmUI/Sources/SwrmUI/BoardModel.swift`:

(a) At the end of `present(pickedFolder:saveBookmark:)`, **after** `reload(storiesDir: storiesDir)`, add a watcher start (only when the dir is valid — i.e. not in the `error` early-return path):

```swift
        startWatching(storiesDir)
```

So the tail of `present` reads:

```swift
        folderName = pickedFolder.lastPathComponent
        currentStoriesDir = storiesDir
        state = .loading
        reload(storiesDir: storiesDir)
        startWatching(storiesDir)
    }
```

(b) Add these two methods after `restoreLastFolder()`:

```swift
    /// Manual re-read of the current folder (refresh button + iOS foreground).
    public func refresh() {
        guard let dir = currentStoriesDir else { return }
        reload(storiesDir: dir)
    }

    private func startWatching(_ dir: URL) {
        let w = FolderWatcher(url: dir) { [weak self] in
            guard let self, let d = self.currentStoriesDir else { return }
            self.reload(storiesDir: d)
        }
        watcher = w
        w.start()
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd native/SwrmUI && swift test --filter BoardModelTests`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the whole UI suite**

Run: `cd native/SwrmUI && swift test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/SwrmUI/Sources/SwrmUI/BoardModel.swift native/SwrmUI/Tests/SwrmUITests/BoardModelTests.swift
git commit -m "feat(ui): BoardModel live file-watch reload + manual refresh"
```

---

## Task 8: FolderPicker (Apps/Shared)

UI glue — not unit-testable; verified by compiling the app targets in Task 9.

**Files:**
- Create: `native/Apps/Shared/FolderPicker.swift`

- [ ] **Step 1: Create the picker**

Create `native/Apps/Shared/FolderPicker.swift`:

```swift
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
import UniformTypeIdentifiers
#endif

/// A button that presents the platform folder picker and reports the chosen URL.
struct FolderPickerButton: View {
    var title: String = "Open Folder…"
    var systemImage: String = "folder"
    var onPick: (URL) -> Void

    #if !os(macOS)
    @State private var presenting = false
    #endif

    var body: some View {
        #if os(macOS)
        Button {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = "Open"
            if panel.runModal() == .OK, let url = panel.url {
                onPick(url)
            }
        } label: {
            Label(title, systemImage: systemImage)
        }
        #else
        Button {
            presenting = true
        } label: {
            Label(title, systemImage: systemImage)
        }
        .sheet(isPresented: $presenting) {
            DocumentPicker(onPick: onPick)
        }
        #endif
    }
}

#if !os(macOS)
private struct DocumentPicker: UIViewControllerRepresentable {
    var onPick: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }
        func documentPicker(_ controller: UIDocumentPickerViewController,
                            didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { onPick(url) }
        }
    }
}
#endif
```

- [ ] **Step 2: Commit**

```bash
git add native/Apps/Shared/FolderPicker.swift
git commit -m "feat(app): FolderPickerButton — NSOpenPanel (macOS) / UIDocumentPicker (iOS)"
```

---

## Task 9: Wire ContentView to BoardModel + build both apps

**Files:**
- Modify: `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Replace ContentView**

Replace the entire contents of `native/Apps/Shared/ContentView.swift` with:

```swift
import SwiftUI
import SwrmCore
import SwrmUI

struct ContentView: View {
    @StateObject private var model = BoardModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.folderName ?? "Swrm")
                .toolbar {
                    ToolbarItemGroup {
                        Button {
                            model.refresh()
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        FolderPickerButton { url in model.openFolder(url) }
                    }
                }
        }
        .onAppear { model.restoreLastFolder() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { model.refresh() }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .idle:
            MessageView(
                icon: "🐝",
                title: "Open a swrm project",
                message: "Pick a folder with .swrm/stories/ — or any folder of story .md files.",
                onPick: { url in model.openFolder(url) }
            )
        case .loading:
            ProgressView("Reading stories…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let board):
            BoardView(board: board)
        case .empty:
            MessageView(
                icon: "📭",
                title: "No stories found",
                message: "This folder has no .md stories with valid front-matter.",
                onPick: { url in model.openFolder(url) }
            )
        case .error(let msg):
            MessageView(
                icon: "⚠️",
                title: "Couldn't open folder",
                message: msg,
                onPick: { url in model.openFolder(url) }
            )
        }
    }
}

/// Centered message + Open-Folder CTA, reused by idle/empty/error states.
private struct MessageView: View {
    let icon: String
    let title: String
    let message: String
    let onPick: (URL) -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text(icon).font(.system(size: 40))
            Text(title).font(.title2.weight(.bold))
            Text(message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            FolderPickerButton { url in onPick(url) }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    BoardView(board: SampleData.board)
}
```

- [ ] **Step 2: Generate the Xcode project**

Run: `cd native && xcodegen generate`
Expected: `Created project at .../native/Swrm.xcodeproj`.

- [ ] **Step 3: Build the macOS app (compile check, signing off)**

Run:
```bash
xcodebuild -project native/Swrm.xcodeproj -scheme SwrmMac \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Build the iOS app (simulator, signing off)**

Run:
```bash
xcodebuild -project native/Swrm.xcodeproj -scheme SwrmiOS \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **`. (If the destination is rejected, list simulators with `xcrun simctl list devices available` and use a concrete `-destination 'platform=iOS Simulator,name=<device>'`.)

- [ ] **Step 5: Commit**

```bash
git add native/Apps/Shared/ContentView.swift
git commit -m "feat(app): wire ContentView to BoardModel — real folder, live board, states"
```

> Note: `native/Swrm.xcodeproj` is generated by XcodeGen and should not be committed if the repo ignores it. Check `git status`; if the project file appears and there is no rule for it, leave it unstaged (the build step regenerates it).

---

## Task 10: Full verification + smoke run

**Files:** none (verification only).

- [ ] **Step 1: Run both Swift test suites**

Run:
```bash
( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )
```
Expected: both report PASS, 0 failures.

- [ ] **Step 2: Manual smoke (macOS, optional but recommended)**

Run the macOS app and confirm against the bundled sample:
```bash
open native/sample/stories
```
Then build & launch SwrmMac (via Xcode Run, or the built `.app` from Task 9), click **Open Folder…**, choose `native/sample/stories`, and confirm:
- All four columns render (Backlog / To Do / In Progress / Done) with the sc-1…sc-5 cards.
- Edit a file in `native/sample/stories` (e.g. change `state:` of `sc-3.md`) and save — the board moves the card within ~1s (live watch).
- Quit and relaunch — the board reopens the same folder automatically.

- [ ] **Step 3: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "chore: Slice A verification fixes"   # only if Step 2 surfaced changes
```

---

## Self-Review

- **Spec coverage:** folder pick (T8/T9) · smart locate (T1) · read-only board render via existing BoardView (T9) · live watch (T3/T7) · refresh + iOS foreground backstop (T7/T9) · bookmark persistence (T2/T6) · LoadState idle/loading/loaded/empty/error (T4–T9) · error resilience: missing dir → error (T5), zero stories → empty (T5), malformed `.md` skipped (relies on `StoryStore.load`'s existing `try?`, exercised indirectly) · both platforms build (T9) · ObservableObject not @Observable (T4) · shared visual tokens (reuses existing Theme/BoardView, unchanged). Web fast-follow + slices B–D explicitly out of scope.
- **Placeholder scan:** none — every code step has complete content.
- **Type consistency:** `LoadState`, `BoardModel(bookmarkStore:)`, `openFolder(_:)`, `restoreLastFolder()`, `refresh()`, `present(pickedFolder:saveBookmark:)`, `reload(storiesDir:)`, `startWatching(_:)`, `FolderWatcher(url:debounceInterval:onChange:)`, `StoriesLocator().resolve(pickedFolder:)`, `BookmarkStore(defaults:)`/`save`/`resolve`/`clear`, `FolderPickerButton(onPick:)` are used consistently across tasks. `StoryStore(directory:).load()` matches the existing API.
```
