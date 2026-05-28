import Foundation

public enum StoryParseError: Error, Equatable {
    case missingFrontMatter
    case missingID
}

/// Parses/serializes a Story to its Markdown form. Hand-rolled YAML front-matter
/// subset (key: value, plus `labels: [a, b]`) — zero external deps on purpose.
public struct StoryParser {
    public init() {}

    public func parse(_ text: String) throws -> Story {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        guard normalized.hasPrefix("---\n") else { throw StoryParseError.missingFrontMatter }
        let afterOpen = normalized.dropFirst(4)
        guard let close = afterOpen.range(of: "\n---\n") ?? afterOpen.range(of: "\n---") else {
            throw StoryParseError.missingFrontMatter
        }
        let fmText = String(afterOpen[afterOpen.startIndex..<close.lowerBound])
        let body = String(afterOpen[close.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)

        var fields: [String: String] = [:]
        for rawLine in fmText.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let colon = rawLine.firstIndex(of: ":") else { continue }
            let key = String(rawLine[rawLine.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(rawLine[rawLine.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if !key.isEmpty { fields[key] = value }
        }

        guard let id = fields["id"], !id.isEmpty else { throw StoryParseError.missingID }
        let type = fields["type"].flatMap(StoryType.init(rawValue:)) ?? .chore
        let state = fields["state"].flatMap(WorkflowState.init(rawValue:)) ?? .backlog
        let epic = fields["epic"].flatMap { $0.isEmpty ? nil : $0 }
        let rank = fields["rank"].flatMap { $0.isEmpty ? nil : $0 }
        let labels = Self.parseList(fields["labels"])

        return Story(id: id, type: type, state: state, epic: epic, labels: labels, rank: rank, body: body)
    }

    public func serialize(_ s: Story) -> String {
        var out = "---\n"
        out += "id: \(s.id)\n"
        out += "type: \(s.type.rawValue)\n"
        out += "state: \(s.state.rawValue)\n"
        if let epic = s.epic { out += "epic: \(epic)\n" }
        out += "labels: [\(s.labels.joined(separator: ", "))]\n"
        if let rank = s.rank { out += "rank: \(rank)\n" }
        out += "---\n"
        return s.body.isEmpty ? out : out + "\n\(s.body)\n"
    }

    static func parseList(_ raw: String?) -> [String] {
        guard var v = raw, !v.isEmpty else { return [] }
        if v.hasPrefix("[") { v.removeFirst() }
        if v.hasSuffix("]") { v.removeLast() }
        return v.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}
