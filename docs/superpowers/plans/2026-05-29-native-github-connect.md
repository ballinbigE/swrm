# Native GitHub Connect (Slice D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Connect a GitHub account in the native app: paste a fine-grained PAT, validate it via `GET /user`, store it in the Keychain, and show "Connected as @you" (with Disconnect). Foundation for D2–D4. Cross-platform (mac + iOS).

**Architecture:** `TokenStore` protocol (Keychain + in-memory impls) + `GitHubClient` with an injectable `fetch` (unit-tested with canned responses) in SwrmCore; `AccountModel` (`@MainActor ObservableObject`) in SwrmUI; a `SettingsView` sheet in Apps. The token lives only in the Keychain — never logged, never in UserDefaults (only the non-secret `login` is cached).

**Tech Stack:** Swift 6.3, SwiftPM, Foundation/Security/URLSession, async XCTest, SwiftUI.

**Spec:** `docs/superpowers/specs/2026-05-29-native-github-connect-design.md`

Paths relative to `/Users/erickbzovi/Projects/swrm`.

---

## Task 1: TokenStore (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/TokenStore.swift`, `native/SwrmCore/Sources/SwrmCore/KeychainTokenStore.swift`, `native/SwrmCore/Tests/SwrmCoreTests/TokenStoreTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmCore/Tests/SwrmCoreTests/TokenStoreTests.swift`:

```swift
import XCTest
@testable import SwrmCore

final class TokenStoreTests: XCTestCase {
    func testInMemoryRoundTrip() throws {
        let s = InMemoryTokenStore()
        XCTAssertNil(try s.load())
        try s.save("abc")
        XCTAssertEqual(try s.load(), "abc")
        try s.delete()
        XCTAssertNil(try s.load())
    }

    func testKeychainRoundTrip() throws {
        let s = KeychainTokenStore(service: "swrm.test.\(UUID().uuidString)")
        do {
            try s.save("tok-123")
        } catch {
            throw XCTSkip("Keychain unavailable in this environment: \(error)")
        }
        XCTAssertEqual(try s.load(), "tok-123")
        try s.delete()
        XCTAssertNil(try s.load())
    }
}
```

- [ ] **Step 2: Run → fail** — `cd native/SwrmCore && swift test --filter TokenStoreTests` → `cannot find 'InMemoryTokenStore'`.

- [ ] **Step 3: Implement**

`native/SwrmCore/Sources/SwrmCore/TokenStore.swift`:

```swift
import Foundation

/// Stores a single secret token. Implementations: Keychain (real) + in-memory (tests).
public protocol TokenStore {
    func save(_ token: String) throws
    func load() throws -> String?
    func delete() throws
}

public final class InMemoryTokenStore: TokenStore {
    private var token: String?
    public init(token: String? = nil) { self.token = token }
    public func save(_ token: String) throws { self.token = token }
    public func load() throws -> String? { token }
    public func delete() throws { token = nil }
}
```

`native/SwrmCore/Sources/SwrmCore/KeychainTokenStore.swift`:

```swift
import Foundation
import Security

public enum KeychainError: Error, Equatable { case unhandled(OSStatus) }

/// `TokenStore` backed by a Keychain generic-password item. macOS + iOS.
public struct KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String
    public init(service: String = "swrm.github", account: String = "token") {
        self.service = service
        self.account = account
    }
    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    public func save(_ token: String) throws {
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
    }
    public func load() throws -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    public func delete() throws {
        let status = SecItemDelete(base as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandled(status)
        }
    }
}
```

- [ ] **Step 4: Run → pass** — `cd native/SwrmCore && swift test --filter TokenStoreTests` (Keychain test may XCTSkip — that's a pass).

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/TokenStore.swift native/SwrmCore/Sources/SwrmCore/KeychainTokenStore.swift native/SwrmCore/Tests/SwrmCoreTests/TokenStoreTests.swift
git commit -m "feat(core): TokenStore protocol + Keychain + in-memory impls"
```

---

## Task 2: GitHubClient (SwrmCore)

**Files:** Create `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`, `native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift`:

```swift
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
```

- [ ] **Step 2: Run → fail** — `cannot find 'GitHubClient'`.

- [ ] **Step 3: Implement** `native/SwrmCore/Sources/SwrmCore/GitHubClient.swift`:

```swift
import Foundation

public struct GitHubAccount: Codable, Equatable {
    public let login: String
    public let name: String?
    public init(login: String, name: String?) { self.login = login; self.name = name }
}

public enum GitHubError: Error, Equatable {
    case unauthorized
    case network(String)
    case decode
}

/// Minimal GitHub REST client. `fetch` is injectable so the API path is fully
/// unit-testable without a network. The token is sent as `Authorization: Bearer`
/// and is never logged.
public struct GitHubClient {
    public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let fetch: Fetch

    public init(fetch: @escaping Fetch = { try await URLSession.shared.data(for: $0) }) {
        self.fetch = fetch
    }

    public func currentUser(token: String) async throws -> GitHubAccount {
        var req = URLRequest(url: URL(string: "https://api.github.com/user")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let data: Data
        let response: URLResponse
        do { (data, response) = try await fetch(req) }
        catch { throw GitHubError.network(error.localizedDescription) }

        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw GitHubError.network("status \(http.statusCode)")
        }
        do { return try JSONDecoder().decode(GitHubAccount.self, from: data) }
        catch { throw GitHubError.decode }
    }
}
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmCore && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmCore/Sources/SwrmCore/GitHubClient.swift native/SwrmCore/Tests/SwrmCoreTests/GitHubClientTests.swift
git commit -m "feat(core): GitHubClient — validate token via GET /user (injectable fetch)"
```

---

## Task 3: AccountModel (SwrmUI)

**Files:** Create `native/SwrmUI/Sources/SwrmUI/AccountModel.swift`, `native/SwrmUI/Tests/SwrmUITests/AccountModelTests.swift`

- [ ] **Step 1: Failing tests**

`native/SwrmUI/Tests/SwrmUITests/AccountModelTests.swift`:

```swift
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
```

- [ ] **Step 2: Run → fail** — `cd native/SwrmUI && swift test --filter AccountModelTests`.

- [ ] **Step 3: Implement** `native/SwrmUI/Sources/SwrmUI/AccountModel.swift`:

```swift
import Foundation
import Combine
import SwrmCore

public enum AccountState: Equatable {
    case disconnected
    case connecting
    case connected(GitHubAccount)
    case error(String)
}

/// Owns the GitHub connection: validate a PAT, persist it in the Keychain, and
/// expose connect/disconnect/restore. The token is never logged; only the
/// non-secret `login` is cached (UserDefaults) for the restore label.
@MainActor
public final class AccountModel: ObservableObject {
    @Published public private(set) var state: AccountState = .disconnected

    private let store: TokenStore
    private let client: GitHubClient
    private let defaults: UserDefaults
    private let loginKey = "swrm.github.login"

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                defaults: UserDefaults = .standard) {
        self.store = store
        self.client = client
        self.defaults = defaults
    }

    public func restore() {
        let token = (try? store.load()) ?? nil
        if let token, !token.isEmpty, let login = defaults.string(forKey: loginKey) {
            state = .connected(GitHubAccount(login: login, name: nil))
        } else {
            state = .disconnected
        }
    }

    public func connect(token: String) async {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        state = .connecting
        do {
            let account = try await client.currentUser(token: trimmed)
            try store.save(trimmed)
            defaults.set(account.login, forKey: loginKey)
            state = .connected(account)
        } catch let e as GitHubError {
            switch e {
            case .unauthorized: state = .error("Invalid or expired token")
            case .network: state = .error("Couldn't reach GitHub")
            case .decode: state = .error("Unexpected response from GitHub")
            }
        } catch {
            state = .error("Keychain unavailable")
        }
    }

    public func disconnect() {
        try? store.delete()
        defaults.removeObject(forKey: loginKey)
        state = .disconnected
    }
}
```

- [ ] **Step 4: Run → pass**, then full `cd native/SwrmUI && swift test`.

- [ ] **Step 5: Commit**
```bash
git add native/SwrmUI/Sources/SwrmUI/AccountModel.swift native/SwrmUI/Tests/SwrmUITests/AccountModelTests.swift
git commit -m "feat(ui): AccountModel — connect/disconnect/restore a GitHub account"
```

---

## Task 4: SettingsView + ContentView gear (Apps)

UI glue — verified by building in Task 5.

**Files:** Create `native/Apps/Shared/SettingsView.swift`; Modify `native/Apps/Shared/ContentView.swift`

- [ ] **Step 1: Create SettingsView**

`native/Apps/Shared/SettingsView.swift`:

```swift
import SwiftUI
import SwrmCore
import SwrmUI

struct SettingsView: View {
    @ObservedObject var account: AccountModel
    @Environment(\.dismiss) private var dismiss
    @State private var pat = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("GitHub") {
                    switch account.state {
                    case .connected(let a):
                        LabeledContent("Connected", value: "@\(a.login)")
                        Button("Disconnect", role: .destructive) { account.disconnect() }
                    case .connecting:
                        HStack { ProgressView(); Text("Connecting…") }
                    default:
                        SecureField("Personal access token", text: $pat)
                        if case let .error(msg) = account.state {
                            Text(msg).font(.caption).foregroundStyle(.red)
                        }
                        Button("Connect") { Task { await account.connect(token: pat) } }
                            .disabled(pat.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
```

- [ ] **Step 2: Wire into ContentView**

In `native/Apps/Shared/ContentView.swift`:
- Add `@StateObject private var account = AccountModel()` and `@State private var showSettings = false`.
- In `.onAppear` (next to `model.restoreLastFolder()`) add `account.restore()`.
- Add a toolbar gear button (in the existing `ToolbarItemGroup`): `Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }`.
- Attach `.sheet(isPresented: $showSettings) { SettingsView(account: account) }` on the NavigationStack (separate level from the existing folder-picker / what's-new sheets).

- [ ] **Step 3: Commit**
```bash
git add native/Apps/Shared/SettingsView.swift native/Apps/Shared/ContentView.swift
git commit -m "feat(app): Settings sheet — connect/disconnect GitHub"
```

---

## Task 5: Build + verify

- [ ] **Step 1: Both suites** — `( cd native/SwrmCore && swift test ) && ( cd native/SwrmUI && swift test )` → all green.
- [ ] **Step 2: Build mac + iOS**
```bash
cd native && xcodegen generate
xcodebuild -project Swrm.xcodeproj -scheme SwrmMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Swrm.xcodeproj -scheme SwrmiOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: `** BUILD SUCCEEDED **` both.
- [ ] **Step 3: Manual** — run SwrmMac, gear → paste a fine-grained PAT → "Connected as @you"; relaunch shows still connected; Disconnect clears it.

---

## Self-Review
- **Spec coverage:** Keychain token store (T1) · in-memory for tests (T1) · GitHubClient validate via `/user` + injectable fetch (T2) · 401/decode/headers (T2) · AccountModel connect/disconnect/restore (T3) · token saved only on success, never on 401 (T3) · login cached not token (T3) · Settings UI (T4) · both platforms (T5). Repo ops / OAuth / GitLab out of scope.
- **Placeholders:** none.
- **Security:** token only via `TokenStore`/Keychain + `Bearer` header; never logged; only `login` in UserDefaults.
- **Type consistency:** `TokenStore.save/load/delete`, `InMemoryTokenStore`, `KeychainTokenStore(service:)`, `GitHubAccount(login:name:)`, `GitHubError.unauthorized/.network/.decode`, `GitHubClient(fetch:).currentUser(token:)`, `AccountModel(store:client:defaults:)` + `.connect/.disconnect/.restore`, `AccountState` — consistent across tasks.
```
