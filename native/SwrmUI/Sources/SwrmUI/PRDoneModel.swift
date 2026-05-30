import Foundation
import Combine
import SwrmCore

public enum MergeResult: Equatable { case merged, notMerged, error(String) }

/// Checks whether a story's branch PR has merged. The card move is done by the caller
/// (BoardModel.moveStory(.done)). Read-only here.
@MainActor
public final class PRDoneModel: ObservableObject {
    @Published public private(set) var lastResult: String?

    private let store: TokenStore
    private let client: GitHubClient
    private let resolveRepo: (URL) -> GitRepoInfo?

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                resolveRepo: @escaping (URL) -> GitRepoInfo? = CIStatusModel.defaultResolve) {
        self.store = store
        self.client = client
        self.resolveRepo = resolveRepo
    }

    @discardableResult
    public func checkMerged(story: Story, dir: URL?) async -> MergeResult {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir) else {
            lastResult = "Connect GitHub and open a repo first"
            return .error("no context")
        }
        let head = "\(info.owner):\(story.branchName())"
        do {
            let merged = try await client.isPullMerged(owner: info.owner, repo: info.repo, head: head, token: token)
            lastResult = merged ? "Marked done" : "PR not merged yet"
            return merged ? .merged : .notMerged
        } catch {
            lastResult = "Couldn't check the PR"
            return .error("check failed")
        }
    }

    public func clear() { lastResult = nil }
}
