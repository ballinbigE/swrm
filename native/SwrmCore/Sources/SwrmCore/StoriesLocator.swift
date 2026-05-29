import Foundation

/// Resolves the directory that actually holds story `.md` files for a picked
/// folder. If `<picked>/.swrm/stories/` exists as a directory, that is the
/// stories dir; otherwise the picked folder itself is treated as the stories dir.
public struct StoriesLocator {
    public init() {}

    public func resolve(pickedFolder: URL) -> URL {
        let candidate = pickedFolder
            .appendingPathComponent(".swrm", isDirectory: true)
            .appendingPathComponent("stories", isDirectory: true)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir),
           isDir.boolValue {
            return candidate
        }
        return pickedFolder
    }
}
