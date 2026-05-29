import XCTest
@testable import SwrmCore

final class ProjectStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var dirs: [URL] = []

    override func setUpWithError() throws {
        suiteName = "swrm.test.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        dirs = []
    }

    override func tearDownWithError() throws {
        for d in dirs { try? FileManager.default.removeItem(at: d) }
        dirs = []
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - Helpers

    private func makeTempDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-ps-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        dirs.append(url)
        return url
    }

    // MARK: - Tests

    func testEmptyOnFreshDefaults() {
        let store = ProjectStore(defaults: defaults)
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    func testUpsertCreatesOneEntry() throws {
        let dir = try makeTempDir()
        let store = ProjectStore(defaults: defaults)
        let entry = store.upsert(url: dir)
        XCTAssertNotNil(entry)
        XCTAssertEqual(store.loadAll().count, 1)
    }

    func testUpsertSamePathDedupes() throws {
        let dir = try makeTempDir()
        let store = ProjectStore(defaults: defaults)
        store.upsert(url: dir)
        store.upsert(url: dir)
        XCTAssertEqual(store.loadAll().count, 1)
    }

    func testUpsertSamePathMovesToFront() throws {
        let dir1 = try makeTempDir()
        let dir2 = try makeTempDir()
        let store = ProjectStore(defaults: defaults)
        store.upsert(url: dir1)
        store.upsert(url: dir2)
        // dir1 is at index 1, dir2 at 0 (most recent front)
        XCTAssertEqual(store.loadAll()[0].path, dir2.resolvingSymlinksInPath().path)

        // Re-upsert dir1 — it should move to front
        store.upsert(url: dir1)
        let all = store.loadAll()
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all[0].path, dir1.resolvingSymlinksInPath().path)
    }

    func testUpsertTrimsToMaxRecents() throws {
        let store = ProjectStore(defaults: defaults)
        var insertedPaths: [String] = []
        for _ in 0..<(ProjectStore.maxRecents + 3) {
            let d = try makeTempDir()
            store.upsert(url: d)
            insertedPaths.append(d.resolvingSymlinksInPath().path)
        }
        let all = store.loadAll()
        XCTAssertEqual(all.count, ProjectStore.maxRecents)
        // The most recently inserted should be at front
        XCTAssertEqual(all[0].path, insertedPaths.last!)
    }

    func testRemoveById() throws {
        let dir = try makeTempDir()
        let store = ProjectStore(defaults: defaults)
        let entry = store.upsert(url: dir)!
        store.remove(id: entry.id)
        XCTAssertTrue(store.loadAll().isEmpty)
    }

    func testResolveReturnsURL() throws {
        let dir = try makeTempDir()
        let store = ProjectStore(defaults: defaults)
        let entry = store.upsert(url: dir)!
        let resolved = store.resolve(entry: entry)
        XCTAssertNotNil(resolved)
        XCTAssertEqual(resolved!.resolvingSymlinksInPath().path,
                       dir.resolvingSymlinksInPath().path)
    }

    func testLegacyMigration() throws {
        let dir = try makeTempDir()
        // Manually write a legacy bookmark into the legacy key
        let legacyKey = "swrm.lastFolderBookmark"
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        defaults.set(bookmarkData, forKey: legacyKey)

        let store = ProjectStore(defaults: defaults)
        let all = store.loadAll()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].path, dir.resolvingSymlinksInPath().path)
        // Legacy key must be removed after migration
        XCTAssertNil(defaults.data(forKey: legacyKey))
    }

    func testLegacyMigrationRunsOnce() throws {
        let dir = try makeTempDir()
        let legacyKey = "swrm.lastFolderBookmark"
        let bookmarkData = try dir.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        defaults.set(bookmarkData, forKey: legacyKey)

        let store = ProjectStore(defaults: defaults)
        let firstLoad = store.loadAll()
        // legacy key gone now
        XCTAssertNil(defaults.data(forKey: legacyKey))
        let secondLoad = store.loadAll()
        // Second loadAll does not re-run migration (legacy key gone), count stays 1
        XCTAssertEqual(firstLoad.count, secondLoad.count)
        XCTAssertEqual(secondLoad.count, 1)
    }

    func testOrderingFrontIsMostRecent() throws {
        let store = ProjectStore(defaults: defaults)
        let dirs = try (0..<3).map { _ in try makeTempDir() }
        for d in dirs { store.upsert(url: d) }
        let all = store.loadAll()
        // Last inserted = front
        XCTAssertEqual(all[0].path, dirs[2].resolvingSymlinksInPath().path)
        XCTAssertEqual(all[1].path, dirs[1].resolvingSymlinksInPath().path)
        XCTAssertEqual(all[2].path, dirs[0].resolvingSymlinksInPath().path)
    }

    func testClearAll() throws {
        let store = ProjectStore(defaults: defaults)
        for _ in 0..<3 {
            let d = try makeTempDir()
            store.upsert(url: d)
        }
        store.clearAll()
        XCTAssertTrue(store.loadAll().isEmpty)
    }
}
