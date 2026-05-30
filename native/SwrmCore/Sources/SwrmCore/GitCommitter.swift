#if os(macOS)
import Foundation

public enum GitError: Error, Equatable {
    case notARepo
    case failed(String)
}

/// Stages + commits a single file in its git repo by shelling out to `git`.
/// macOS only — iOS has no git binary / `Process`. Foundation-only, no UI.
public struct GitCommitter {
    public init() {}

    /// Commit just `file` with `message`. Returns the new HEAD sha.
    /// No-op (returns current HEAD) when there is nothing to commit.
    @discardableResult
    public func commit(file: URL, message: String) throws -> String {
        let fileDir = file.deletingLastPathComponent()
        let top = try run(["rev-parse", "--show-toplevel"], inDir: fileDir)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !top.isEmpty else { throw GitError.notARepo }
        let repo = URL(fileURLWithPath: top)

        _ = try run(["add", "--", file.path], inDir: repo)
        do {
            _ = try run(["commit", "-m", message, "--", file.path], inDir: repo)
        } catch let GitError.failed(out) where out.contains("nothing to commit") {
            // unchanged / already committed — fine
        }
        return try run(["rev-parse", "HEAD"], inDir: repo)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    private func run(_ args: [String], inDir dir: URL) throws -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        proc.arguments = ["-C", dir.path] + args
        let out = Pipe(); let err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        do { try proc.run() } catch { throw GitError.failed("\(error)") }
        proc.waitUntilExit()
        let outStr = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errStr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if proc.terminationStatus != 0 {
            if errStr.contains("not a git repository") { throw GitError.notARepo }
            throw GitError.failed(outStr + errStr)
        }
        return outStr
    }
}
#endif
