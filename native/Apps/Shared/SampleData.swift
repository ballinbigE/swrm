import SwrmCore

/// Inline sample board for the foundation demo — mirrors
/// `native/sample/.swrm/stories/*.md`. Real `.swrm/stories` directory loading
/// (via SwrmCore.StoryStore, already unit-tested) is wired in a later increment.
enum SampleData {
    static let markdown: [String] = [
        """
        ---
        id: sc-1
        type: feature
        state: started
        epic: onboarding
        labels: [ios, p1]
        rank: a
        ---
        Wire up the login screen
        """,
        """
        ---
        id: sc-2
        type: bug
        state: unstarted
        labels: [auth]
        rank: a
        ---
        Token refresh drops session on cold start
        """,
        """
        ---
        id: sc-3
        type: chore
        state: backlog
        rank: a
        ---
        Bump dependencies to latest minor
        """,
        """
        ---
        id: sc-4
        type: feature
        state: done
        epic: onboarding
        labels: [web]
        rank: a
        ---
        Add empty-state illustration to board
        """,
        """
        ---
        id: sc-5
        type: feature
        state: started
        labels: [core]
        rank: b
        ---
        Parse front-matter without a YAML dependency
        """,
    ]

    static var stories: [Story] {
        let parser = StoryParser()
        return markdown.compactMap { try? parser.parse($0) }
    }

    static var board: Board {
        Board(stories: stories)
    }
}
