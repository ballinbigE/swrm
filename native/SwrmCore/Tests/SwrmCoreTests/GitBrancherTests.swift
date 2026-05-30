#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitBrancherTests: XCTestCase {
    func testCreatesAndSwitches() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-br-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) -> String {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a
            let o = Pipe(); p.standardOutput = o; p.standardError = Pipe(); try? p.run(); p.waitUntilExit()
            return String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        }
        _ = git(["init"]); _ = git(["config", "user.email", "t@t"]); _ = git(["config", "user.name", "t"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        _ = git(["add", "-A"]); _ = git(["commit", "-m", "c"])

        try GitBrancher().createOrSwitch(branch: "sc-1/x", in: dir)
        XCTAssertEqual(git(["rev-parse", "--abbrev-ref", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines), "sc-1/x")
        // already exists → switch, no throw
        XCTAssertNoThrow(try GitBrancher().createOrSwitch(branch: "sc-1/x", in: dir))
    }
}
#endif
