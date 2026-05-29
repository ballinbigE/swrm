import SwiftUI
import SwrmCore
import SwrmUI

struct ContentView: View {
    @StateObject private var model = BoardModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var isPickingFolder = false
    @AppStorage("swrm.lastSeenWhatsNew") private var lastSeenWhatsNew = ""
    @State private var showWhatsNew = false

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.folderName ?? "Swrm")
                .toolbar {
                    ToolbarItemGroup {
                        Button {
                            model.refresh()
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        ProjectSwitcherMenu(model: model, onOpenNew: { isPickingFolder = true })
                    }
                    ToolbarItem(placement: .automatic) {
                        Text("v\(appVersion)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .sheet(isPresented: $showWhatsNew) {
                    WhatsNewView(onDismiss: {
                        lastSeenWhatsNew = WhatsNew.version
                        showWhatsNew = false
                    })
                }
        }
        .folderPicker(isPresented: $isPickingFolder, onPick: { url in model.openFolder(url) })
        .onAppear {
            model.restoreLastFolder()
            if lastSeenWhatsNew != WhatsNew.version {
                showWhatsNew = true
            }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { model.refresh() }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .idle:
            MessageView(
                icon: "🐝",
                title: "Open a swrm project",
                message: "Pick a folder with .swrm/stories/ — or any folder of story .md files.",
                onPick: { url in model.openFolder(url) }
            )
        case .loading:
            ProgressView("Reading stories…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let board):
            BoardView(board: board, onMove: { id, newState in model.moveStory(id, to: newState) })
        case .empty:
            MessageView(
                icon: "📭",
                title: "No stories found",
                message: "This folder has no .md stories with valid front-matter.",
                onPick: { url in model.openFolder(url) }
            )
        case .error(let msg):
            MessageView(
                icon: "⚠️",
                title: "Couldn't open folder",
                message: msg,
                onPick: { url in model.openFolder(url) }
            )
        }
    }
}

/// Centered message + Open-Folder CTA, reused by idle/empty/error states.
private struct MessageView: View {
    let icon: String
    let title: String
    let message: String
    let onPick: (URL) -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text(icon).font(.system(size: 40))
            Text(title).font(.title2.weight(.bold))
            Text(message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            FolderPickerButton { url in onPick(url) }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    BoardView(board: SampleData.board)
}
