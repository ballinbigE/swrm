import Foundation
import Combine
import SwrmCore

public enum PushState: Equatable {
    case idle
    case working
    case opened(url: String)
    case error(String)
}

/// Push the current branch + open a PR. Push/branch are injectable seams so the
/// orchestration is unit-testable without a real remote.
@MainActor
public final class PushPRModel: ObservableObject {
    @Published public private(set) var state: PushState = .idle

    private let store: TokenStore
    private let client: GitHubClient
    private let resolveRepo: (URL) -> GitRepoInfo?
    private let currentBranch: (URL) -> String?
    private let push: (String, String, String, String, URL) throws -> Void

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                resolveRepo: @escaping (URL) -> GitRepoInfo? = CIStatusModel.defaultResolve,
                currentBranch: @escaping (URL) -> String? = PushPRModel.resolveCurrentBranch,
                push: @escaping (String, String, String, String, URL) throws -> Void = PushPRModel.defaultPush) {
        self.store = store
        self.client = client
        self.resolveRepo = resolveRepo
        self.currentBranch = currentBranch
        self.push = push
    }

    public static let resolveCurrentBranch: (URL) -> String? = { dir in
        #if os(macOS)
        return GitPusher().currentBranch(in: dir)
        #else
        return nil
        #endif
    }
    public static let defaultPush: (String, String, String, String, URL) throws -> Void = { owner, repo, branch, token, dir in
        #if os(macOS)
        try GitPusher().push(owner: owner, repo: repo, branch: branch, token: token, in: dir)
        #else
        throw GitHubError.network("push unavailable on iOS")
        #endif
    }

    public func reset() { state = .idle }

    public func pushAndOpenPR(dir: URL?) async {
        guard let dir,
              let token = (try? store.load()) ?? nil, !token.isEmpty,
              let info = resolveRepo(dir),
              let branch = currentBranch(dir) else {
            state = .error("Connect GitHub and open a git repo first")
            return
        }
        state = .working
        do {
            try push(info.owner, info.repo, branch, token, dir)
            let base = try await client.defaultBranch(owner: info.owner, repo: info.repo, token: token)
            let pr = try await client.openPullRequest(owner: info.owner, repo: info.repo, head: branch, base: base, title: branch, token: token)
            state = .opened(url: pr.htmlURL)
        } catch let e as GitHubError {
            switch e {
            case .unauthorized: state = .error("Token not authorized for this repo")
            case .network(let m): state = .error(m)
            case .decode: state = .error("Unexpected response from GitHub")
            }
        } catch {
            state = .error("Push failed")
        }
    }
}
