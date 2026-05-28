import SwiftUI
import SwrmCore

/// The whole board: horizontally-scrolling workflow-state columns.
public struct BoardView: View {
    public let board: Board

    public init(board: Board) {
        self.board = board
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(board.columns, id: \.state) { column in
                    ColumnView(column: column)
                }
            }
            .padding(16)
        }
        .background(SwrmTheme.charcoal.ignoresSafeArea())
    }
}

struct ColumnView: View {
    let column: BoardColumn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(column.state.title)
                    .font(.headline)
                    .foregroundColor(SwrmTheme.cream)
                Spacer()
                Text("\(column.stories.count)")
                    .font(.subheadline)
                    .foregroundColor(SwrmTheme.muted)
            }
            ForEach(column.stories, id: \.id) { story in
                StoryCardView(story: story)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(width: 260, alignment: .topLeading)
        .background(SwrmTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(column.state.accent.opacity(0.4), lineWidth: 1)
        )
    }
}

struct StoryCardView: View {
    let story: Story

    private var firstLine: String {
        story.body.split(separator: "\n").first.map(String.init) ?? story.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(story.id)
                    .font(.caption.monospaced())
                    .foregroundColor(SwrmTheme.muted)
                Spacer()
                Text(story.type.rawValue)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(SwrmTheme.honey.opacity(0.22))
                    .foregroundColor(SwrmTheme.honeyLight)
                    .clipShape(Capsule())
            }
            Text(firstLine)
                .font(.subheadline)
                .foregroundColor(SwrmTheme.cream)
                .lineLimit(2)
            if !story.labels.isEmpty {
                HStack(spacing: 4) {
                    ForEach(story.labels, id: \.self) { label in
                        Text(label)
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(SwrmTheme.muted.opacity(0.18))
                            .foregroundColor(SwrmTheme.muted)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SwrmTheme.charcoal.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
