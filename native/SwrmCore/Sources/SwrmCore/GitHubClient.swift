import Foundation

public struct GitHubAccount: Codable, Equatable {
    public let login: String
    public let name: String?
    public init(login: String, name: String?) { self.login = login; self.name = name }
}

public enum GitHubError: Error, Equatable {
    case unauthorized
    case network(String)
    case decode
}

/// Minimal GitHub REST client. `fetch` is injectable so the API path is fully
/// unit-testable without a network. The token is sent as `Authorization: Bearer`
/// and is never logged.
public struct GitHubClient {
    public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let fetch: Fetch

    public init(fetch: @escaping Fetch = { try await URLSession.shared.data(for: $0) }) {
        self.fetch = fetch
    }

    public func currentUser(token: String) async throws -> GitHubAccount {
        var req = URLRequest(url: URL(string: "https://api.github.com/user")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let data: Data
        let response: URLResponse
        do { (data, response) = try await fetch(req) }
        catch { throw GitHubError.network(error.localizedDescription) }

        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw GitHubError.network("status \(http.statusCode)")
        }
        do { return try JSONDecoder().decode(GitHubAccount.self, from: data) }
        catch { throw GitHubError.decode }
    }
}
