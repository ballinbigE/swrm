import Foundation

/// owner/repo + HEAD sha for a git repo. (Struct is cross-platform; the reader is macOS-only.)
public struct GitRepoInfo: Equatable, Sendable {
    public let owner: String
    public let repo: String
    public let headSHA: String
    public init(owner: String, repo: String, headSHA: String) {
        self.owner = owner; self.repo = repo; self.headSHA = headSHA
    }
}

#if os(macOS)
/// Resolves repo identity via the `git` CLI. macOS only.
public struct GitRepoReader {
    public init() {}

    public func info(for directory: URL) -> GitRepoInfo? {
        guard let sha = run(["rev-parse", "HEAD"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sha.isEmpty,
              let remote = run(["remote", "get-url", "origin"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let parsed = Self.parseGitHubRemote(remote)
        else { return nil }
        return GitRepoInfo(owner: parsed.owner, repo: parsed.repo, headSHA: sha)
    }

    public static func parseGitHubRemote(_ url: String) -> (owner: String, repo: String)? {
        guard let r = url.range(of: "github.com") else { return nil }
        var tail = String(url[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: ":/"))
        if tail.hasSuffix(".git") { tail = String(tail.dropLast(4)) }
        let parts = tail.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count >= 2 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    private func run(_ args: [String], in dir: URL) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}
#endif
