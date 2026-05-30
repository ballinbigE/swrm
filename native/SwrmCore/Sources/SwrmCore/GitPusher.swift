#if os(macOS)
import Foundation

public enum GitPushError: Error, Equatable { case failed(String) }

/// Pushes the current branch to GitHub over HTTPS, authenticating with a token via a
/// transient `-c http.extraHeader` arg (not persisted, not in the URL). macOS only.
public struct GitPusher {
    public init() {}

    public func currentBranch(in directory: URL) -> String? {
        guard let out = run(["rev-parse", "--abbrev-ref", "HEAD"], in: directory)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !out.isEmpty, out != "HEAD" else { return nil }
        return out
    }

    public func push(owner: String, repo: String, branch: String, token: String, in directory: URL) throws {
        let url = "https://github.com/\(owner)/\(repo).git"
        let (status, _, err) = capture(
            ["-c", "http.extraHeader=Authorization: Bearer \(token)",
             "push", url, "HEAD:refs/heads/\(branch)"],
            in: directory)
        guard status == 0 else {
            throw GitPushError.failed(err.replacingOccurrences(of: token, with: "***"))
        }
    }

    private func run(_ args: [String], in dir: URL) -> String? {
        let (s, out, _) = capture(args, in: dir)
        return s == 0 ? out : nil
    }
    private func capture(_ args: [String], in dir: URL) -> (Int32, String, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        let o = Pipe(); let e = Pipe(); p.standardOutput = o; p.standardError = e
        do { try p.run() } catch { return (-1, "", "\(error)") }
        p.waitUntilExit()
        let out = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: e.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus, out, err)
    }
}
#endif
