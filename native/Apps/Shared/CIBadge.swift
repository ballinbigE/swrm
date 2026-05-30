import SwiftUI
import SwrmCore

/// A small CI pill for the repo HEAD. Hidden when status is `.none`.
struct CIBadge: View {
    let status: CIStatus
    var onTap: () -> Void

    var body: some View {
        if let info = display {
            Button(action: onTap) {
                HStack(spacing: 5) {
                    Circle().fill(info.color).frame(width: 8, height: 8)
                    Text(info.label).font(.caption)
                }
            }
            .buttonStyle(.plain)
            .help("CI for HEAD — tap to refresh")
        }
    }

    private var display: (label: String, color: Color)? {
        switch status {
        case .success: return ("Passing", .green)
        case .failure: return ("Failing", .red)
        case .pending: return ("Running", .yellow)
        case .none: return nil
        }
    }
}
