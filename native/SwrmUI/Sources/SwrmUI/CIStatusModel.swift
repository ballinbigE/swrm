import Foundation
import Combine
import SwrmCore

/// Live CI status for the current repo HEAD. Read-only, never persisted.
@MainActor
public final class CIStatusModel: ObservableObject {
    @Published public private(set) var status: CIStatus = .none

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

    public static let defaultResolve: (URL) -> GitRepoInfo? = { dir in
        #if os(macOS)
        return GitRepoReader().info(for: dir)
        #else
        return nil
        #endif
    }

    public func refresh(dir: URL?) async {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir) else { status = .none; return }
        do {
            status = try await client.ciStatus(owner: info.owner, repo: info.repo, ref: info.headSHA, token: token)
        } catch {
            status = .none
        }
    }
}
