import Foundation

public struct BoardColumn: Equatable, Sendable {
    public let state: WorkflowState
    public var stories: [Story]
}

/// A board = stories grouped into the four workflow-state columns, each ordered
/// by `rank` (lexorank string compare; nil ranks sort first).
public struct Board: Equatable, Sendable {
    public var columns: [BoardColumn]

    public init(stories: [Story]) {
        columns = WorkflowState.allCases.map { state in
            let inState = stories
                .filter { $0.state == state }
                .sorted { ($0.rank ?? "") < ($1.rank ?? "") }
            return BoardColumn(state: state, stories: inState)
        }
    }
}
