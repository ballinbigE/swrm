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

    func testDefaultBranch() async throws {
        let c = client(status: 200, body: #"{"default_branch":"main"}"#)
        let b = try await c.defaultBranch(owner: "o", repo: "r", token: "t")
        XCTAssertEqual(b, "main")
    }

    func testOpenPullRequestReturnsRef() async throws {
        let c = client(status: 201, body: #"{"number":7,"html_url":"https://github.com/o/r/pull/7"}"#)
        let pr = try await c.openPullRequest(owner: "o", repo: "r", head: "feat", base: "main", title: "feat", token: "t")
        XCTAssertEqual(pr, PullRequestRef(number: 7, htmlURL: "https://github.com/o/r/pull/7"))
    }

    func testOpenPullRequest422IsFriendlyError() async {
        let c = client(status: 422, body: #"{"message":"Validation Failed"}"#)
        do { _ = try await c.openPullRequest(owner: "o", repo: "r", head: "feat", base: "main", title: "feat", token: "t"); XCTFail() }
        catch { if case let GitHubError.network(m) = error { XCTAssertTrue(m.contains("already exist")) } else { XCTFail("\(error)") } }
    }

    func testIsPullMergedTrueWhenMergedAtPresent() async throws {
        let c = client(status: 200, body: #"[{"merged_at":"2026-05-30T00:00:00Z"}]"#)
        let merged = try await c.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        XCTAssertTrue(merged)
    }
    func testIsPullMergedFalseWhenNullOrEmpty() async throws {
        let n = client(status: 200, body: #"[{"merged_at":null}]"#)
        let nullResult = try await n.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        XCTAssertFalse(nullResult)
        let e = client(status: 200, body: "[]")
        let emptyResult = try await e.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        XCTAssertFalse(emptyResult)
    }
    func testIsPullMergedSendsHeadQueryItem() async throws {
        var captured: URLRequest?
        let c = GitHubClient(fetch: { req in
            captured = req
            return (Data("[]".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        _ = try await c.isPullMerged(owner: "o", repo: "r", head: "o:feat", token: "t")
        let comps = URLComponents(url: captured!.url!, resolvingAgainstBaseURL: false)
        XCTAssertEqual(comps?.queryItems?.first(where: { $0.name == "head" })?.value, "o:feat")
    }

    func testCIStatusRollup() async throws {
        func runs(_ json: String) -> GitHubClient { client(status: 200, body: json) }
        // all completed/success
        let ok = try await runs(#"{"check_runs":[{"status":"completed","conclusion":"success"}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(ok, .success)
        // a failure
        let bad = try await runs(#"{"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(bad, .failure)
        // in progress
        let run = try await runs(#"{"check_runs":[{"status":"in_progress","conclusion":null}]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(run, .pending)
        // empty
        let none = try await runs(#"{"check_runs":[]}"#).ciStatus(owner: "o", repo: "r", ref: "s", token: "t")
        XCTAssertEqual(none, .none)
    }
}
