import Foundation

/// Ordered recents registry persisted as a single JSON blob in UserDefaults.
/// Ordering = list position (front = most recent); wall-clock is NOT used for
/// ordering so tests remain deterministic.
///
/// Plain bookmarks (options: []) are used because the app is currently non-sandboxed.
/// TODO(distribution slice): switch to `.withSecurityScope` when running inside
/// the App Sandbox so security-scoped bookmarks survive relaunches on sandboxed
/// macOS / iOS.
public struct ProjectStore {
    private let defaults: UserDefaults
    private let key = "swrm.projects"
    private let legacyKey = "swrm.lastFolderBookmark"
    public static let maxRecents = 10

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - Public API

    /// Returns all entries in stored order (front = most recent).
    /// On first call, migrates the legacy single-bookmark key if present.
    @discardableResult
    public func loadAll() -> [ProjectEntry] {
        // One-time legacy migration: runs only if new key is absent AND legacy key is present.
        if defaults.object(forKey: key) == nil, defaults.data(forKey: legacyKey) != nil {
            migrateLegacy()
        }
        return decode()
    }

    /// Creates or bumps an entry to the front of the list. Returns the entry on
    /// success, nil if a bookmark could not be created for the URL.
    @discardableResult
    public func upsert(url: URL) -> ProjectEntry? {
        guard let bookmarkData = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return nil }

        let resolvedPath = url.resolvingSymlinksInPath().path
        var entries = decode()

        if let idx = entries.firstIndex(where: { $0.path == resolvedPath }) {
            // Update existing entry and move to front.
            var existing = entries[idx]
            existing.bookmark = bookmarkData
            existing.lastOpened = Date()
            entries.remove(at: idx)
            entries.insert(existing, at: 0)
            encode(entries)
            return existing
        } else {
            // Prepend new entry.
            let entry = ProjectEntry(
                displayName: url.lastPathComponent,
                path: resolvedPath,
                bookmark: bookmarkData,
                lastOpened: Date()
            )
            entries.insert(entry, at: 0)
            if entries.count > Self.maxRecents {
                entries = Array(entries.prefix(Self.maxRecents))
            }
            encode(entries)
            return entry
        }
    }

    /// Resolves the bookmark for an entry. On stale-but-resolved: refreshes bookmark
    /// and persists. On failure: removes the entry and persists. Returns nil on failure.
    public func resolve(entry: ProjectEntry) -> URL? {
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: entry.bookmark,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else {
            remove(id: entry.id)
            return nil
        }
        if stale {
            // Refresh the stored bookmark.
            if let fresh = try? url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            ) {
                var entries = decode()
                if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
                    entries[idx].bookmark = fresh
                    encode(entries)
                }
            }
        }
        return url
    }

    /// Removes the entry with the given ID.
    public func remove(id: UUID) {
        var entries = decode()
        entries.removeAll { $0.id == id }
        encode(entries)
    }

    /// Removes all entries.
    public func clearAll() {
        defaults.removeObject(forKey: key)
    }

    // MARK: - Private helpers

    private func decode() -> [ProjectEntry] {
        guard let data = defaults.data(forKey: key),
              let entries = try? JSONDecoder().decode([ProjectEntry].self, from: data)
        else { return [] }
        return entries
    }

    private func encode(_ entries: [ProjectEntry]) {
        if let data = try? JSONEncoder().encode(entries) {
            defaults.set(data, forKey: key)
        }
    }

    /// Runs once: reads the legacy single-bookmark, builds a ProjectEntry, saves
    /// it under the new key, and always removes the legacy key.
    private func migrateLegacy() {
        defer { defaults.removeObject(forKey: legacyKey) }
        guard let data = defaults.data(forKey: legacyKey) else { return }
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else { return }
        // Re-create a fresh bookmark from the resolved URL.
        guard let freshData = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return }
        let entry = ProjectEntry(
            displayName: url.lastPathComponent,
            path: url.resolvingSymlinksInPath().path,
            bookmark: freshData,
            lastOpened: Date()
        )
        encode([entry])
    }
}
