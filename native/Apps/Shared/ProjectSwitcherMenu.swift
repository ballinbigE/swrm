import SwiftUI
import SwrmCore
import SwrmUI

struct ProjectSwitcherMenu: View {
    @ObservedObject var model: BoardModel
    var onOpenNew: () -> Void

    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif

    var body: some View {
        Menu {
            if !model.recentProjects.isEmpty {
                ForEach(model.recentProjects) { entry in
                    Button {
                        model.openProject(entry)
                    } label: {
                        Label(
                            entry.displayName,
                            systemImage: entry.id == model.currentProjectID
                                ? "checkmark.circle.fill"
                                : "folder"
                        )
                    }
                }
                Divider()
            }
            Button {
                onOpenNew()
            } label: {
                Label("Open Folder…", systemImage: "folder.badge.plus")
            }
            #if os(macOS)
            Divider()
            Button {
                openWindow(id: "board")
            } label: {
                Label("Open in New Window", systemImage: "macwindow.badge.plus")
            }
            #endif
        } label: {
            Label(model.folderName ?? "Projects", systemImage: "square.stack.3d.up")
        }
    }
}
