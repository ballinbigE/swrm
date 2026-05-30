#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitCommitterTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swrm-git-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    @discardableResult
    private func git(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run(); p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    private func initRepo() throws -> URL {
        try git(["init"])
        try git(["config", "user.email", "t@t.test"])
        try git(["config", "user.name", "Tester"])
        let file = dir.appendingPathComponent("sc-1.md")
        try "---\nid: sc-1\nstate: backlog\n---\nx".write(to: file, atomically: true, encoding: .utf8)
        try git(["add", "-A"]); try git(["commit", "-m", "init"])
        return file
    }

    func testCommitsAChangedFileAndReturnsSha() throws {
        let file = try initRepo()
        try "---\nid: sc-1\nstate: started\n---\nx".write(to: file, atomically: true, encoding: .utf8)
        let sha = try GitCommitter().commit(file: file, message: "sc-1: backlog → started")
        XCTAssertFalse(sha.isEmpty)
        let subject = try git(["log", "-1", "--format=%s"]).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(subject, "sc-1: backlog → started")
    }

    func testUnchangedFileIsNoOp() throws {
        let file = try initRepo()
        // no modification → "nothing to commit" must not throw
        XCTAssertNoThrow(try GitCommitter().commit(file: file, message: "noop"))
    }

    func testNonRepoThrowsNotARepo() throws {
        let file = dir.appendingPathComponent("loose.md")
        try "hi".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try GitCommitter().commit(file: file, message: "x")) { err in
            XCTAssertEqual(err as? GitError, .notARepo)
        }
    }
}
#endif
