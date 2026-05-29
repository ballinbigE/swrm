import Foundation

/// Persists a bookmark to the last-opened folder so it survives relaunches.
/// Foundation-only. Slice A uses default (plain) bookmark options because the
/// macOS app is non-sandboxed; `.withSecurityScope` + sandbox entitlements are
/// deferred to the distribution slice.
public struct BookmarkStore {
    private let defaults: UserDefaults
    private let key = "swrm.lastFolderBookmark"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func save(_ url: URL) {
        if let data = try? url.bookmarkData(
            options: [],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) {
            defaults.set(data, forKey: key)
        }
    }

    public func resolve() -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        var stale = false
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: [],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        if stale {
            defaults.removeObject(forKey: key)
            return nil
        }
        return url
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}
