import XCTest
@testable import SwrmUI
import SwrmCore

@MainActor
final class AccountModelTests: XCTestCase {
    private func freshDefaults() -> UserDefaults { UserDefaults(suiteName: "swrm.acct.\(UUID().uuidString)")! }
    private func client(status: Int, body: String) -> GitHubClient {
        GitHubClient(fetch: { req in
            let r = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(body.utf8), r)
        })
    }

    func testConnectSuccessSavesTokenAndConnects() async throws {
        let store = InMemoryTokenStore()
        let m = AccountModel(store: store, client: client(status: 200, body: #"{"login":"octocat","name":null}"#), defaults: freshDefaults())
        await m.connect(token: " tok ")
        guard case let .connected(a) = m.state else { return XCTFail("\(m.state)") }
        XCTAssertEqual(a.login, "octocat")
        XCTAssertEqual(try store.load(), "tok") // trimmed + saved
    }

    func testConnect401ErrorsAndDoesNotSave() async throws {
        let store = InMemoryTokenStore()
        let m = AccountModel(store: store, client: client(status: 401, body: ""), defaults: freshDefaults())
        await m.connect(token: "bad")
        guard case .error = m.state else { return XCTFail("\(m.state)") }
        XCTAssertNil(try store.load())
    }

    func testDisconnectClearsToken() throws {
        let store = InMemoryTokenStore(token: "tok")
        let d = freshDefaults(); d.set("octocat", forKey: "swrm.github.login")
        let m = AccountModel(store: store, client: client(status: 200, body: "{}"), defaults: d)
        m.disconnect()
        XCTAssertEqual(m.state, .disconnected)
        XCTAssertNil(try store.load())
    }

    func testRestoreFromSavedToken() throws {
        let store = InMemoryTokenStore(token: "tok")
        let d = freshDefaults(); d.set("octocat", forKey: "swrm.github.login")
        let m = AccountModel(store: store, client: client(status: 200, body: "{}"), defaults: d)
        m.restore()
        guard case let .connected(a) = m.state else { return XCTFail("\(m.state)") }
        XCTAssertEqual(a.login, "octocat")
    }
}
