import SwiftUI
import SwrmCore
import SwrmUI

struct ContentView: View {
    @StateObject private var model = BoardModel()
    @StateObject private var account = AccountModel()
    @StateObject private var ci = CIStatusModel()
    @StateObject private var pushPR = PushPRModel()
    @StateObject private var branch = BranchModel()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var isPickingFolder = false
    @AppStorage("swrm.lastSeenWhatsNew") private var lastSeenWhatsNew = ""
    @State private var showWhatsNew = false
    @State private var showSettings = false

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    private var startWorkHandler: ((Story) -> Void)? {
        #if os(macOS)
        return { story in branch.startWork(story: story, dir: model.storiesDirectory) }
        #else
        return nil
        #endif
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.folderName ?? "Swrm")
                .task(id: model.folderName) { await ci.refresh(dir: model.storiesDirectory) }
                .alert("Start work", isPresented: Binding(
                    get: { branch.lastResult != nil },
                    set: { if !$0 { branch.clear() } }
                )) {
                    Button("OK", role: .cancel) { }
                } message: { Text(branch.lastResult ?? "") }
                .alert("Push & PR", isPresented: Binding(
                    get: {
                        switch pushPR.state { case .opened, .error: return true; default: return false }
                    },
                    set: { if !$0 { pushPR.reset() } }
                )) {
                    if case let .opened(url) = pushPR.state, let u = URL(string: url) {
                        Button("Open PR") { openURL(u) }
                    }
                    Button("OK", role: .cancel) { }
                } message: {
                    switch pushPR.state {
                    case .opened(let url): Text("Pull request opened:\n\(url)")
                    case .error(let m): Text(m)
                    default: Text("")
                    }
                }
                .toolbar {
                    ToolbarItemGroup {
                        Button {
                            model.refresh()
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        ProjectSwitcherMenu(model: model, onOpenNew: { isPickingFolder = true })
                        CIBadge(status: ci.status) { Task { await ci.refresh(dir: model.storiesDirectory) } }
                        #if os(macOS)
                        Button {
                            Task { await pushPR.pushAndOpenPR(dir: model.storiesDirectory) }
                        } label: {
                            if case .working = pushPR.state { ProgressView() } else { Label("Push & PR", systemImage: "arrow.up.circle") }
                        }
                        .disabled({ if case .working = pushPR.state { return true } else { return false } }())
                        #endif
                        Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
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
        .sheet(isPresented: $showSettings) { SettingsView(account: account) }
        .folderPicker(isPresented: $isPickingFolder, onPick: { url in model.openFolder(url) })
        .onAppear {
            model.restoreLastFolder()
            account.restore()
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
            BoardView(board: board, onMove: { id, newState in model.moveStory(id, to: newState) }, onStartWork: startWorkHandler)
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
