import XCTest
@testable import SwrmUI
import SwrmCore

final class BoardModelTests: XCTestCase {
    func testInitialStateIsIdle() {
        let model = BoardModel(bookmarkStore: BookmarkStore(defaults: Self.scratchDefaults()))
        XCTAssertEqual(model.state, .idle)
    }

    // MARK: helpers (used by later tasks too)

    static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "swrm.uitest.\(UUID().uuidString)")!
    }
}
