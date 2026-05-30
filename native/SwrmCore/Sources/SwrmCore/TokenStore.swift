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
