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
