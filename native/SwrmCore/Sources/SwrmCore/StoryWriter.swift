import Foundation

public enum StoryWriteError: Error, Equatable {
    case notFound
}

/// Surgically rewrites a story's `state:` front-matter line in place, leaving the
/// rest of the file (body, comments, unknown keys, ordering) byte-identical.
/// Pure Foundation — no UI. Operates on `\n`-joined lines (CRLF is normalized to LF).
public struct StoryWriter {
    public init() {}

    @discardableResult
    public func setState(storyID: String, to newState: WorkflowState, in directory: URL) throws -> URL {
        let url = try fileURL(for: storyID, in: directory)
        let text = try String(contentsOf: url, encoding: .utf8)
        let updated = Self.replaceState(in: text, with: newState.rawValue)
        try updated.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func fileURL(for id: String, in dir: URL) throws -> URL {
        let direct = dir.appendingPathComponent("\(id).md")
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        let parser = StoryParser()
        for u in entries where u.pathExtension == "md" {
            if let text = try? String(contentsOf: u, encoding: .utf8),
               let s = try? parser.parse(text), s.id == id {
                return u
            }
        }
        throw StoryWriteError.notFound
    }

    /// Replace (or insert) the `state:` line inside the front-matter block only.
    static func replaceState(in text: String, with raw: String) -> String {
        var lines = text.components(separatedBy: "\n")
        guard let open = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
        else { return text }
        let rest = lines[(open + 1)...]
        guard let closeOffset = rest.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
        else { return text }
        let close = closeOffset // firstIndex on a slice returns an absolute index
        for i in (open + 1)..<close {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed == "state" || trimmed.hasPrefix("state:") || trimmed.hasPrefix("state ") {
                let indent = String(lines[i].prefix(while: { $0 == " " || $0 == "\t" }))
                lines[i] = "\(indent)state: \(raw)"
                return lines.joined(separator: "\n")
            }
        }
        lines.insert("state: \(raw)", at: open + 1)
        return lines.joined(separator: "\n")
    }
}
