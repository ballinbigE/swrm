import XCTest
@testable import SwrmCore

final class SwrmCoreTests: XCTestCase {
    let sample = """
    ---
    id: sc-42
    type: feature
    state: started
    epic: onboarding
    labels: [ios, p1]
    rank: 0|hzzzzz:
    ---
    Wire up the login screen.
    - [ ] form
    - [ ] validation
    """

    func testParsesFrontMatter() throws {
        let s = try StoryParser().parse(sample)
        XCTAssertEqual(s.id, "sc-42")
        XCTAssertEqual(s.type, .feature)
        XCTAssertEqual(s.state, .started)
        XCTAssertEqual(s.epic, "onboarding")
        XCTAssertEqual(s.labels, ["ios", "p1"])
        XCTAssertEqual(s.rank, "0|hzzzzz:")
        XCTAssertTrue(s.body.hasPrefix("Wire up the login screen."))
    }

    func testRoundTrip() throws {
        let p = StoryParser()
        let s = try p.parse(sample)
        let s2 = try p.parse(p.serialize(s))
        XCTAssertEqual(s, s2)
    }

    func testDefaultsForMissingFields() throws {
        let s = try StoryParser().parse("---\nid: sc-1\n---\nhi")
        XCTAssertEqual(s.type, .chore)
        XCTAssertEqual(s.state, .backlog)
        XCTAssertNil(s.epic)
        XCTAssertEqual(s.labels, [])
        XCTAssertEqual(s.body, "hi")
    }

    func testMissingFrontMatterThrows() {
        XCTAssertThrowsError(try StoryParser().parse("no front matter"))
    }

    func testMissingIDThrows() {
        XCTAssertThrowsError(try StoryParser().parse("---\ntype: bug\n---\nx"))
    }

    func testBranchName() {
        let s = Story(id: "sc-42", body: "Wire up the login screen.\nmore")
        XCTAssertEqual(s.branchName(), "sc-42/wire-up-the-login-screen")
    }

    func testBoardGroupsIntoFourOrderedColumns() {
        let stories = [
            Story(id: "sc-1", state: .backlog, rank: "b"),
            Story(id: "sc-2", state: .started, rank: "a"),
            Story(id: "sc-3", state: .started, rank: "b"),
            Story(id: "sc-4", state: .done),
        ]
        let board = Board(stories: stories)
        XCTAssertEqual(board.columns.map { $0.state }, [.backlog, .unstarted, .started, .done])
        let started = board.columns.first { $0.state == .started }!
        XCTAssertEqual(started.stories.map { $0.id }, ["sc-2", "sc-3"])
    }
}
