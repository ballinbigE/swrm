#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitPusherTests: XCTestCase {
    func testCurrentBranch() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-push-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) { let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a; p.standardOutput = Pipe(); p.standardError = Pipe(); try? p.run(); p.waitUntilExit() }
        git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        git(["add", "-A"]); git(["commit", "-m", "c"]); git(["branch", "-M", "feature-xyz"])
        XCTAssertEqual(GitPusher().currentBranch(in: dir), "feature-xyz")
    }
}
#endif
