import Foundation

/// A single entry in the recents registry.
public struct ProjectEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID
    public var displayName: String   // url.lastPathComponent at save time
    public var path: String          // url.resolvingSymlinksInPath().path — for dedupe + display
    public var bookmark: Data
    public var lastOpened: Date

    public init(
        id: UUID = UUID(),
        displayName: String,
        path: String,
        bookmark: Data,
        lastOpened: Date
    ) {
        self.id = id
        self.displayName = displayName
        self.path = path
        self.bookmark = bookmark
        self.lastOpened = lastOpened
    }
}
