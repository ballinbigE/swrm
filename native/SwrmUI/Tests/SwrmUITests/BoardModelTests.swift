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
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
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
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(storiesCount(model.state), 2)
        XCTAssertEqual(model.folderName, dir.lastPathComponent)
    }

    func testOpenEmptyFolderIsEmptyState() throws {
        let dir = try makeStoriesDir([])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(model.state, .empty)
    }

    func testOpenMissingFolderIsErrorState() {
        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-missing-\(UUID().uuidString)", isDirectory: true)
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(missing)
        if case .error = model.state { } else { XCTFail("expected .error, got \(model.state)") }
    }

    func testRestoreWithNoBookmarkIsIdle() {
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.restoreLastFolder()
        XCTAssertEqual(model.state, .idle)
    }

    func testRestoreReopensSavedFolder() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let defaults = Self.scratchDefaults()

        // First launch: open + persist.
        let first = BoardModel(projectStore: ProjectStore(defaults: defaults))
        first.openFolder(dir)
        XCTAssertEqual(storiesCount(first.state), 1)

        // Second launch: a fresh model restores from the same store.
        let second = BoardModel(projectStore: ProjectStore(defaults: defaults))
        second.restoreLastFolder()
        XCTAssertEqual(storiesCount(second.state), 1)
    }

    func testRefreshPicksUpNewlyEmptiedFolder() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
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
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
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

    // MARK: - Task E: new recents tests

    func testOpenFolderPopulatesRecentProjects() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir)
        XCTAssertEqual(model.recentProjects.count, 1)
        XCTAssertNotNil(model.currentProjectID)
        XCTAssertEqual(model.recentProjects[0].path, dir.resolvingSymlinksInPath().path)
    }

    func testOpenTwoDifferentFoldersBuildsRecents() throws {
        let dir1 = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let dir2 = try makeStoriesDir([
            "---\nid: sc-2\nstate: backlog\n---\nBump deps",
        ])
        let model = BoardModel(projectStore: ProjectStore(defaults: Self.scratchDefaults()))
        model.openFolder(dir1)
        model.openFolder(dir2)

        XCTAssertEqual(model.recentProjects.count, 2)
        // Most recent (dir2) at front
        XCTAssertEqual(model.recentProjects[0].path, dir2.resolvingSymlinksInPath().path)
        XCTAssertEqual(model.currentProjectID, model.recentProjects[0].id)
    }

    func testOpenProjectSwitchesFolderAndCurrentID() throws {
        let dir1 = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let dir2 = try makeStoriesDir([
            "---\nid: sc-2\nstate: backlog\n---\nBump deps",
        ])
        let store = ProjectStore(defaults: Self.scratchDefaults())
        let model = BoardModel(projectStore: store)
        model.openFolder(dir1)
        model.openFolder(dir2)

        // Remember the first entry
        let firstEntry = model.recentProjects.first(where: { $0.path == dir1.resolvingSymlinksInPath().path })!

        // Switch back to the first project
        model.openProject(firstEntry)
        XCTAssertEqual(model.folderName, dir1.lastPathComponent)
        XCTAssertEqual(model.currentProjectID, firstEntry.id)
    }

    func testRestoreLastFolderAfterOpenFolder() throws {
        let dir = try makeStoriesDir([
            "---\nid: sc-1\nstate: started\n---\nWire login",
        ])
        let defaults = Self.scratchDefaults()
        let first = BoardModel(projectStore: ProjectStore(defaults: defaults))
        first.openFolder(dir)

        let second = BoardModel(projectStore: ProjectStore(defaults: defaults))
        second.restoreLastFolder()
        XCTAssertEqual(second.folderName, dir.lastPathComponent)
        XCTAssertNotNil(second.currentProjectID)
    }

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

    // MARK: helpers

    static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "swrm.uitest.\(UUID().uuidString)")!
    }
}
