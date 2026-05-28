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
