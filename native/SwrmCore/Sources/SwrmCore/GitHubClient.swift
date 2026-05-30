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

    public func defaultBranch(owner: String, repo: String, token: String) async throws -> String {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct Repo: Codable { let default_branch: String }
        do { return try JSONDecoder().decode(Repo.self, from: data).default_branch } catch { throw GitHubError.decode }
    }

    public func isPullMerged(owner: String, repo: String, head: String, token: String) async throws -> Bool {
        var comps = URLComponents(string: "https://api.github.com/repos/\(owner)/\(repo)/pulls")!
        comps.queryItems = [
            URLQueryItem(name: "state", value: "all"),
            URLQueryItem(name: "head", value: head),
            URLQueryItem(name: "per_page", value: "10"),
        ]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct PR: Codable { let merged_at: String? }
        do { return try JSONDecoder().decode([PR].self, from: data).contains { $0.merged_at != nil } }
        catch { throw GitHubError.decode }
    }

    public func openPullRequest(owner: String, repo: String, head: String, base: String, title: String, token: String) async throws -> PullRequestRef {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)/pulls")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["title": title, "head": head, "base": base])
        let data: Data; let response: URLResponse
        do { (data, response) = try await fetch(req) } catch { throw GitHubError.network(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw GitHubError.network("no response") }
        if http.statusCode == 401 { throw GitHubError.unauthorized }
        if http.statusCode == 422 { throw GitHubError.network("a pull request may already exist for this branch") }
        guard (200..<300).contains(http.statusCode) else { throw GitHubError.network("status \(http.statusCode)") }
        struct PR: Codable { let number: Int; let html_url: String }
        do { let pr = try JSONDecoder().decode(PR.self, from: data); return PullRequestRef(number: pr.number, htmlURL: pr.html_url) }
        catch { throw GitHubError.decode }
    }
}

struct CheckRunsResponse: Codable { let check_runs: [CheckRun] }
struct CheckRun: Codable { let status: String; let conclusion: String? }

public struct PullRequestRef: Equatable {
    public let number: Int
    public let htmlURL: String
    public init(number: Int, htmlURL: String) { self.number = number; self.htmlURL = htmlURL }
}
