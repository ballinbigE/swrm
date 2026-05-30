import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class CIStatusModelTests: XCTestCase {
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in
            let r = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), r)
        })
    }
    private let dummyDir = URL(fileURLWithPath: "/tmp/swrm-ci")

    func testSuccessWhenTokenRepoAndGreen() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(token: "t"),
            client: client(status: 200, body: #"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "sha") }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .success)
    }

    func testNoneWithoutToken() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(),
            client: client(status: 200, body: #"{"check_runs":[]}"#),
            resolveRepo: { _ in GitRepoInfo(owner: "o", repo: "r", headSHA: "sha") }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .none)
    }

    func testNoneWhenNotAGitHubRepo() async {
        let m = CIStatusModel(
            store: InMemoryTokenStore(token: "t"),
            client: client(status: 200, body: #"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#),
            resolveRepo: { _ in nil }
        )
        await m.refresh(dir: dummyDir)
        XCTAssertEqual(m.status, .none)
    }
}
