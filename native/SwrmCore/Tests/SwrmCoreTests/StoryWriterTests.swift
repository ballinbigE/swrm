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
        let returned = try StoryWriter().setState(storyID: "sc-1", to: .started, in: dir)
        XCTAssertEqual(returned.lastPathComponent, "sc-1.md")
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
