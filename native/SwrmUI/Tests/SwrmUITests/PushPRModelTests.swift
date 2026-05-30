import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class PushPRModelTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/swrm-pushpr")
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in
            let r = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), r)
        })
    }
    // a client that returns default_branch then a PR depending on the path
    private func prClient() -> GitHubClient {
        GitHubClient(fetch: { req in
            let path = req.url!.path
            let body = path.hasSuffix("/pulls")
                ? #"{"number":7,"html_url":"https://github.com/o/r/pull/7"}"#
                : #"{"default_branch":"main"}"#
            let status = path.hasSuffix("/pulls") ? 201 : 200
            return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
    }

    func testHappyPathOpensPR() async {
        var pushed = false
        let m = PushPRModel(
            store: InMemoryTokenStore(token: "tok"), client: prClient(),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" },
            push: { _, _, _, _, _ in pushed = true }
        )
        await m.pushAndOpenPR(dir: dir)
        XCTAssertTrue(pushed)
        XCTAssertEqual(m.state, .opened(url: "https://github.com/o/r/pull/7"))
    }

    func testNoTokenErrors() async {
        let m = PushPRModel(store: InMemoryTokenStore(), client: prClient(),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" }, push: { _, _, _, _, _ in })
        await m.pushAndOpenPR(dir: dir)
        if case .error = m.state {} else { XCTFail("\(m.state)") }
    }

    func testPushFailureStopsBeforePR() async {
        var prOpened = false
        let m = PushPRModel(
            store: InMemoryTokenStore(token: "tok"),
            client: GitHubClient(fetch: { req in prOpened = req.url!.path.hasSuffix("/pulls"); return (Data("{}".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "s") },
            currentBranch: { _ in "feature-x" },
            push: { _, _, _, _, _ in throw GitPushErrorStub.boom }
        )
        await m.pushAndOpenPR(dir: dir)
        if case .error = m.state {} else { XCTFail("\(m.state)") }
        XCTAssertFalse(prOpened)
    }
}

enum GitPushErrorStub: Error { case boom }
