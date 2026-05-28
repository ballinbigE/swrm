import Foundation

/// Shortcut-style story type.
public enum StoryType: String, Codable, CaseIterable, Sendable {
    case feature, bug, chore
}

/// The four Shortcut workflow-state *types* — board columns derive from these.
public enum WorkflowState: String, Codable, CaseIterable, Sendable {
    case backlog, unstarted, started, done
}

/// A Swrm story — the atomic unit. One Markdown file with YAML front-matter.
public struct Story: Equatable, Sendable {
    public var id: String
    public var type: StoryType
    public var state: WorkflowState
    public var epic: String?
    public var labels: [String]
    public var rank: String?
    public var body: String

    public init(
        id: String,
        type: StoryType = .chore,
        state: WorkflowState = .backlog,
        epic: String? = nil,
        labels: [String] = [],
        rank: String? = nil,
        body: String = ""
    ) {
        self.id = id
        self.type = type
        self.state = state
        self.epic = epic
        self.labels = labels
        self.rank = rank
        self.body = body
    }

    /// Git branch convention: `sc-<id>/<slug-of-first-body-line>`.
    public func branchName() -> String {
        let firstLine = body.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        let slug = Story.slugify(firstLine)
        return slug.isEmpty ? id : "\(id)/\(slug)"
    }

    static func slugify(_ s: String) -> String {
        let mapped = s.lowercased().map { ch -> Character in
            (ch.isLetter || ch.isNumber) ? ch : "-"
        }
        let collapsed = String(mapped).split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(40))
    }
}
