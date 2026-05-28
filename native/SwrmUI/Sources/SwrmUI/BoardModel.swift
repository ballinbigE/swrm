import Foundation
import Combine
import SwrmCore

/// What the board UI is currently showing.
public enum LoadState: Equatable {
    case idle
    case loading
    case loaded(Board)
    case empty
    case error(String)
}

/// Owns the selected folder, loads/derives the board, and live-refreshes it as
/// the underlying `.swrm/stories/*.md` files change. Read-only (Slice A).
public final class BoardModel: ObservableObject {
    @Published public private(set) var state: LoadState = .idle
    @Published public private(set) var folderName: String?

    private let bookmarkStore: BookmarkStore
    private let locator = StoriesLocator()

    public init(bookmarkStore: BookmarkStore = BookmarkStore()) {
        self.bookmarkStore = bookmarkStore
    }
}
