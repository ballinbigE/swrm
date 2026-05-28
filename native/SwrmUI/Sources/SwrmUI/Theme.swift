import SwiftUI
import SwrmCore

public enum SwrmTheme {
    public static let charcoal = Color(hex: "#15130F")
    public static let surface = Color(hex: "#1F1B14")
    public static let honey = Color(hex: "#F5A623")
    public static let honeyLight = Color(hex: "#FFC24B")
    public static let cream = Color(hex: "#F3E9D2")
    public static let muted = Color(hex: "#B9AE94")
}

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

extension WorkflowState {
    var title: String {
        switch self {
        case .backlog: return "Backlog"
        case .unstarted: return "To Do"
        case .started: return "In Progress"
        case .done: return "Done"
        }
    }

    var accent: Color {
        switch self {
        case .backlog: return SwrmTheme.muted
        case .unstarted: return Color(hex: "#93C5FD")
        case .started: return SwrmTheme.honey
        case .done: return Color(hex: "#4ADE80")
        }
    }
}
