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
    private var watcher: FolderWatcher?
    private var currentStoriesDir: URL?
    private var scopedURL: URL?

    public init(bookmarkStore: BookmarkStore = BookmarkStore()) {
        self.bookmarkStore = bookmarkStore
    }

    deinit {
        watcher?.stop()
        scopedURL?.stopAccessingSecurityScopedResource()
    }

    /// Open a folder the user picked (persists it for next launch).
    public func openFolder(_ url: URL) {
        present(pickedFolder: url, saveBookmark: true)
    }

    /// Re-open the folder saved on a previous launch, if any.
    public func restoreLastFolder() {
        guard let url = bookmarkStore.resolve() else {
            state = .idle
            return
        }
        present(pickedFolder: url, saveBookmark: false)
    }

    /// Manual re-read of the current folder (refresh button + iOS foreground).
    public func refresh() {
        guard let dir = currentStoriesDir else { return }
        reload(storiesDir: dir)
    }

    private func startWatching(_ dir: URL) {
        let w = FolderWatcher(url: dir) { [weak self] in
            guard let self, let d = self.currentStoriesDir else { return }
            self.reload(storiesDir: d)
        }
        watcher = w
        w.start()
    }

    private func present(pickedFolder: URL, saveBookmark: Bool) {
        // Release any previously-open folder.
        watcher?.stop(); watcher = nil
        scopedURL?.stopAccessingSecurityScopedResource(); scopedURL = nil

        // Needed for iOS document-picker URLs; harmless `false` for plain URLs.
        if pickedFolder.startAccessingSecurityScopedResource() {
            scopedURL = pickedFolder
        }
        if saveBookmark { bookmarkStore.save(pickedFolder) }

        let storiesDir = locator.resolve(pickedFolder: pickedFolder)
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: storiesDir.path, isDirectory: &isDir)
        guard exists, isDir.boolValue,
              FileManager.default.isReadableFile(atPath: storiesDir.path) else {
            state = .error("Couldn't read folder. Re-open it.")
            return
        }

        folderName = pickedFolder.lastPathComponent
        currentStoriesDir = storiesDir
        state = .loading
        reload(storiesDir: storiesDir)
        startWatching(storiesDir)
    }

    private func reload(storiesDir: URL) {
        let stories = (try? StoryStore(directory: storiesDir).load()) ?? []
        let board = Board(stories: stories)
        let isEmpty = board.columns.allSatisfy { $0.stories.isEmpty }
        let next: LoadState = isEmpty ? .empty : .loaded(board)
        if next != state { state = next }
    }
}
