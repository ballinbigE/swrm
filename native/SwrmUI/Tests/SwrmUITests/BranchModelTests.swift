import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class BranchModelTests: XCTestCase {
    func testStartWorkCallsBrancherWithStoryBranch() {
        var captured: (String, URL)?
        let m = BranchModel(brancher: { b, d in captured = (b, d) })
        let story = Story(id: "sc-1", body: "Wire up the login screen")
        m.startWork(story: story, dir: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(captured?.0, story.branchName())
        XCTAssertEqual(m.lastResult, "On \(story.branchName())")
    }

    func testNilDirErrorsAndDoesNotCallBrancher() {
        var called = false
        let m = BranchModel(brancher: { _, _ in called = true })
        m.startWork(story: Story(id: "sc-1"), dir: nil)
        XCTAssertFalse(called)
        XCTAssertNotNil(m.lastResult)
    }

    func testBrancherThrowSetsError() {
        let m = BranchModel(brancher: { _, _ in throw NSError(domain: "x", code: 1) })
        m.startWork(story: Story(id: "sc-1"), dir: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(m.lastResult, "Couldn't create branch")
    }
}
