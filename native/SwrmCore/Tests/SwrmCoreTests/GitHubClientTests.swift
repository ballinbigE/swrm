import XCTest
@testable import SwrmCore

final class GitHubClientTests: XCTestCase {
    private func client(status: Int, body: String, capture: ((URLRequest) -> Void)? = nil) -> GitHubClient {
        GitHubClient(fetch: { req in
            capture?(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), resp)
        })
    }

    func testReturnsAccountOn200() async throws {
        let c = client(status: 200, body: #"{"login":"octocat","name":"The Octocat"}"#)
        let a = try await c.currentUser(token: "x")
        XCTAssertEqual(a, GitHubAccount(login: "octocat", name: "The Octocat"))
    }

    func testSendsBearerAndAcceptHeaders() async throws {
        var captured: URLRequest?
        let c = client(status: 200, body: #"{"login":"x","name":null}"#) { captured = $0 }
        _ = try await c.currentUser(token: "secret")
        XCTAssertEqual(captured?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(captured?.value(forHTTPHeaderField: "Accept"), "application/vnd.github+json")
        XCTAssertEqual(captured?.url?.absoluteString, "https://api.github.com/user")
    }

    func testThrowsUnauthorizedOn401() async {
        let c = client(status: 401, body: "")
        do { _ = try await c.currentUser(token: "x"); XCTFail("expected throw") }
        catch { XCTAssertEqual(error as? GitHubError, .unauthorized) }
    }

    func testThrowsDecodeOnBadJSON() async {
        let c = client(status: 200, body: "not json")
        do { _ = try await c.currentUser(token: "x"); XCTFail("expected throw") }
        catch { XCTAssertEqual(error as? GitHubError, .decode) }
    }
}
