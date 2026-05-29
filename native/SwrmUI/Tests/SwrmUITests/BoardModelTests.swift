import XCTest
@testable import SwrmUI
import SwrmCore
import Combine

@MainActor
final class BoardModelTests: XCTestCase {
    private var createdDirs: [URL] = []

    override func tearDownWithError() throws {
        for dir in createdDirs { try? FileManager.default.removeItem(at: dir) }
        createdDirs = []
    }

    func testInitialStateIsIdle() {
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        XCTAssertEqual(model.state, .idle)
    }

    func makeStoriesDir(_ markdown: [String]) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-board-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        createdDirs.append(dir)
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
        expectation.assertForOverFulfill = false
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

    // MARK: helpers (used by later tasks too)

    static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "swrm.uitest.\(UUID().uuidString)")!
    }
}
