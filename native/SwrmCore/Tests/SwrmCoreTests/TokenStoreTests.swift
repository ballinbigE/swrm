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
