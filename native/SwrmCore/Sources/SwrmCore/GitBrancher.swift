#if os(macOS)
import Foundation

public enum GitBranchError: Error, Equatable { case failed(String) }

/// Creates + checks out a branch (or switches to it if it already exists). macOS only.
public struct GitBrancher {
    public init() {}

    public func createOrSwitch(branch: String, in directory: URL) throws {
        let (s, _, err) = capture(["switch", "-c", branch], in: directory)
        if s == 0 { return }
        let (s2, _, err2) = capture(["switch", branch], in: directory)
        guard s2 == 0 else { throw GitBranchError.failed(err + err2) }
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
