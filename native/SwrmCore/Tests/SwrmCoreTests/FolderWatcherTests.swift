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
