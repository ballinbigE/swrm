import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class PRDoneModelTests: XCTestCase {
    private let dir = URL(fileURLWithPath: "/tmp/swrm-prdone")
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!) })
    }
    private func repo(_ info: GitRepoInfo?) -> (URL) -> GitRepoInfo? { { _ in info } }

    func testMerged() async {
        let m = PRDoneModel(store: InMemoryTokenStore(token: "t"),
                            client: client(status: 200, body: #"[{"merged_at":"2026-05-30T00:00:00Z"}]"#),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        let r = await m.checkMerged(story: Story(id: "sc-1", body: "x"), dir: dir)
        XCTAssertEqual(r, .merged)
        XCTAssertEqual(m.lastResult, "Marked done")
    }
    func testNotMerged() async {
        let m = PRDoneModel(store: InMemoryTokenStore(token: "t"),
                            client: client(status: 200, body: "[]"),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        let result = await m.checkMerged(story: Story(id: "sc-1"), dir: dir)
        XCTAssertEqual(result, .notMerged)
    }
    func testNoTokenIsError() async {
        let m = PRDoneModel(store: InMemoryTokenStore(),
                            client: client(status: 200, body: "[]"),
                            resolveRepo: repo(GitRepoInfo(owner: "o", repo: "r", headSHA: "s")))
        if case .error = await m.checkMerged(story: Story(id: "sc-1"), dir: dir) {} else { XCTFail() }
    }
}
