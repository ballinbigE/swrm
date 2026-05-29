import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
import UniformTypeIdentifiers
#endif

/// A button that presents the platform folder picker and reports the chosen URL.
struct FolderPickerButton: View {
    var title: String = "Open Folder…"
    var systemImage: String = "folder"
    var onPick: (URL) -> Void

    #if !os(macOS)
    @State private var presenting = false
    #endif

    var body: some View {
        #if os(macOS)
        Button {
            presentFolderPanel(onPick: onPick)
        } label: {
            Label(title, systemImage: systemImage)
        }
        #else
        Button {
            presenting = true
        } label: {
            Label(title, systemImage: systemImage)
        }
        .sheet(isPresented: $presenting) {
            DocumentPicker(onPick: onPick)
        }
        #endif
    }
}

// MARK: - Programmatic trigger modifier

extension View {
    /// Presents the platform folder picker when `isPresented` becomes `true`.
    /// On macOS, runs `NSOpenPanel`; on iOS, shows a sheet with `UIDocumentPickerViewController`.
    func folderPicker(isPresented: Binding<Bool>, onPick: @escaping (URL) -> Void) -> some View {
        modifier(FolderPickerModifier(isPresented: isPresented, onPick: onPick))
    }
}

private struct FolderPickerModifier: ViewModifier {
    @Binding var isPresented: Bool
    var onPick: (URL) -> Void

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .onChange(of: isPresented) { newValue in
                guard newValue else { return }
                presentFolderPanel(onPick: onPick)
                isPresented = false
            }
        #else
        content
            .sheet(isPresented: $isPresented) {
                DocumentPicker(onPick: onPick)
            }
        #endif
    }
}

// MARK: - Helpers

#if os(macOS)
private func presentFolderPanel(onPick: (URL) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Open"
    if panel.runModal() == .OK, let url = panel.url {
        onPick(url)
    }
}
#else
private struct DocumentPicker: UIViewControllerRepresentable {
    var onPick: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }
        func documentPicker(_ controller: UIDocumentPickerViewController,
                            didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { onPick(url) }
        }
    }
}
#endif
