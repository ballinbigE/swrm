import Foundation
import Combine
import SwrmCore

/// "Start work" — create + check out a story's branch. `brancher` is an injectable
/// seam so it's unit-testable without git.
@MainActor
public final class BranchModel: ObservableObject {
    @Published public private(set) var lastResult: String?

    private let brancher: (String, URL) throws -> Void

    public init(brancher: @escaping (String, URL) throws -> Void = BranchModel.defaultBrancher) {
        self.brancher = brancher
    }

    public static let defaultBrancher: (String, URL) throws -> Void = { branch, dir in
        #if os(macOS)
        try GitBrancher().createOrSwitch(branch: branch, in: dir)
        #else
        throw NSError(domain: "swrm.branch", code: 1)  // iOS: unsupported (UI hides the action)
        #endif
    }

    public func startWork(story: Story, dir: URL?) {
        guard let dir else { lastResult = "Open a git repo first"; return }
        let branch = story.branchName()
        do {
            try brancher(branch, dir)
            lastResult = "On \(branch)"
        } catch {
            lastResult = "Couldn't create branch"
        }
    }

    public func clear() { lastResult = nil }
}
