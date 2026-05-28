import Foundation

/// Loads stories from a `.swrm/stories/*.md` directory. Foundation FS only —
/// no networking, per the standalone-native constraint.
public struct StoryStore {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public func load() throws -> [Story] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ) else {
            return []
        }
        let parser = StoryParser()
        var stories: [Story] = []
        for url in entries where url.pathExtension == "md" {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            if let story = try? parser.parse(text) {
                stories.append(story)
            }
        }
        return stories
    }

    public func board() throws -> Board {
        Board(stories: try load())
    }
}
