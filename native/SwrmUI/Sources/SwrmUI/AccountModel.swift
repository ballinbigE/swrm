import Foundation
import Combine
import SwrmCore

public enum AccountState: Equatable {
    case disconnected
    case connecting
    case connected(GitHubAccount)
    case error(String)
}

/// Owns the GitHub connection: validate a PAT, persist it in the Keychain, and
/// expose connect/disconnect/restore. The token is never logged; only the
/// non-secret `login` is cached (UserDefaults) for the restore label.
@MainActor
public final class AccountModel: ObservableObject {
    @Published public private(set) var state: AccountState = .disconnected

    private let store: TokenStore
    private let client: GitHubClient
    private let defaults: UserDefaults
    private let loginKey = "swrm.github.login"

    public init(store: TokenStore = KeychainTokenStore(),
                client: GitHubClient = GitHubClient(),
                defaults: UserDefaults = .standard) {
        self.store = store
        self.client = client
        self.defaults = defaults
    }

    public func restore() {
        let token = (try? store.load()) ?? nil
        if let token, !token.isEmpty, let login = defaults.string(forKey: loginKey) {
            state = .connected(GitHubAccount(login: login, name: nil))
        } else {
            state = .disconnected
        }
    }

    public func connect(token: String) async {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        state = .connecting
        do {
            let account = try await client.currentUser(token: trimmed)
            try store.save(trimmed)
            defaults.set(account.login, forKey: loginKey)
            state = .connected(account)
        } catch let e as GitHubError {
            switch e {
            case .unauthorized: state = .error("Invalid or expired token")
            case .network: state = .error("Couldn't reach GitHub")
            case .decode: state = .error("Unexpected response from GitHub")
            }
        } catch {
            state = .error("Keychain unavailable")
        }
    }

    public func disconnect() {
        try? store.delete()
        defaults.removeObject(forKey: loginKey)
        state = .disconnected
    }
}
