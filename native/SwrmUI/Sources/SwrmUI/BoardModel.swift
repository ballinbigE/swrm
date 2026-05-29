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
///
/// `@MainActor`: every path mutates the `@Published` properties, which Combine
/// requires on the main thread. The watcher already hops to main before calling
/// back; this annotation makes the guarantee compile-time.
///
/// TODO(distribution slice): once the app is sandboxed, switch ProjectStore to
/// `.withSecurityScope` bookmarks.
@MainActor
public final class BoardModel: ObservableObject {
    @Published public private(set) var state: LoadState = .idle
    @Published public private(set) var folderName: String?
    @Published public private(set) var recentProjects: [ProjectEntry] = []
    @Published public private(set) var currentProjectID: UUID?

    private let projectStore: ProjectStore
    private let locator = StoriesLocator()
    private var watcher: FolderWatcher?
    private var currentStoriesDir: URL?
    private var scopedURL: URL?

    public init(projectStore: ProjectStore = ProjectStore()) {
        self.projectStore = projectStore
        self.recentProjects = projectStore.loadAll()
    }

    deinit {
        watcher?.stop()
        scopedURL?.stopAccessingSecurityScopedResource()
    }

    /// Open a folder the user picked (persists it for next launch).
    public func openFolder(_ url: URL) {
        // Validate before registering in recents.
        let storiesDir = locator.resolve(pickedFolder: url)
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: storiesDir.path, isDirectory: &isDir)
        guard exists, isDir.boolValue,
              FileManager.default.isReadableFile(atPath: storiesDir.path) else {
            state = .error("Couldn't read folder. Re-open it.")
            return
        }

        present(pickedFolder: url)
        if let entry = projectStore.upsert(url: url) {
            currentProjectID = entry.id
        }
        recentProjects = projectStore.loadAll()
    }

    /// Open a project from the recents list (re-upserts to bump it to front).
    public func openProject(_ entry: ProjectEntry) {
        guard let url = projectStore.resolve(entry: entry) else {
            recentProjects = projectStore.loadAll()
            state = .error("Couldn't open project. Re-add it.")
            return
        }
        present(pickedFolder: url)
        if let bumped = projectStore.upsert(url: url) {
            currentProjectID = bumped.id
        }
        recentProjects = projectStore.loadAll()
    }

    /// Re-open the folder saved on a previous launch, if any.
    public func restoreLastFolder() {
        guard let first = projectStore.loadAll().first,
              let url = projectStore.resolve(entry: first) else {
            state = .idle
            return
        }
        present(pickedFolder: url)
        currentProjectID = first.id
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

    private func present(pickedFolder: URL) {
        // Release any previously-open folder.
        watcher?.stop(); watcher = nil
        scopedURL?.stopAccessingSecurityScopedResource(); scopedURL = nil

        // Needed for iOS document-picker URLs; harmless `false` for plain/non-
        // sandboxed URLs (macOS dev build), so we deliberately do NOT treat a
        // `false` return as an error here.
        // TODO(distribution slice): once the app is sandboxed, a `false` here is
        // a genuine access denial and should surface `state = .error(...)`.
        if pickedFolder.startAccessingSecurityScopedResource() {
            scopedURL = pickedFolder
        }

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
