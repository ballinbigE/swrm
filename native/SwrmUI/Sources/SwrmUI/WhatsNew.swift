public enum WhatsNew {
    public static let version = "0.8.0"
    public static let title = "swrm v0.8.0 — Push & Open PR"
    public static let items: [String] = [
        "🚀 Push & open a PR. One button on the Mac board pushes your current branch to GitHub and opens a pull request into your default branch. Then 'Open PR' jumps you straight there.",
        "🔐 Your token stays put. Push auth rides in a transient request header — never written to git config, the remote URL, or any log. (Mac only.)"
    ]
}
