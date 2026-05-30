#if os(macOS)
import XCTest
@testable import SwrmCore

final class GitRepoReaderTests: XCTestCase {
    func testParsesSshAndHttpsRemotes() {
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("git@github.com:ballinbigE/swrm.git").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("https://github.com/ballinbigE/swrm").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertEqual(GitRepoReader.parseGitHubRemote("https://github.com/ballinbigE/swrm.git").map { "\($0.owner)/\($0.repo)" }, "ballinbigE/swrm")
        XCTAssertNil(GitRepoReader.parseGitHubRemote("https://gitlab.com/x/y.git"))
    }

    func testInfoForRealTempRepo() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("swrm-repo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func git(_ a: [String]) { let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir.path] + a; p.standardOutput = Pipe(); p.standardError = Pipe(); try? p.run(); p.waitUntilExit() }
        git(["init"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"])
        git(["remote", "add", "origin", "git@github.com:ballinbigE/swrm.git"])
        try "x".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        git(["add", "-A"]); git(["commit", "-m", "c"])
        let info = GitRepoReader().info(for: dir)
        XCTAssertEqual(info?.owner, "ballinbigE")
        XCTAssertEqual(info?.repo, "swrm")
        XCTAssertEqual(info?.headSHA.count, 40)
    }
}
#endif
