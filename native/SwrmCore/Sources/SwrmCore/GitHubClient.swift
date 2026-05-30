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

    public func ciStatus(owner: String, repo: String, ref: String, token: String) async throws -> CIStatus {
        let url = URL(string: "https://api.github.com/repos/\(owner)/\(repo)/commits/\(ref)/check-runs")!
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        let decoded: CheckRunsResponse
        do { decoded = try JSONDecoder().decode(CheckRunsResponse.self, from: data) } catch { throw GitHubError.decode }
        return GitHubClient.rollup(decoded.check_runs)
    }

    static func rollup(_ runs: [CheckRun]) -> CIStatus {
        if runs.isEmpty { return .none }
        let failing: Set<String> = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]
        if runs.contains(where: { failing.contains($0.conclusion ?? "") }) { return .failure }
        if runs.contains(where: { $0.status != "completed" }) { return .pending }
        return .success
    }
}

struct CheckRunsResponse: Codable { let check_runs: [CheckRun] }
struct CheckRun: Codable { let status: String; let conclusion: String? }
