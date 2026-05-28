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
