import SwiftUI
import SwrmCore
import SwrmUI

struct SettingsView: View {
    @ObservedObject var account: AccountModel
    @Environment(\.dismiss) private var dismiss
    @State private var pat = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("GitHub") {
                    switch account.state {
                    case .connected(let a):
                        LabeledContent("Connected", value: "@\(a.login)")
                        Button("Disconnect", role: .destructive) { account.disconnect() }
                    case .connecting:
                        HStack { ProgressView(); Text("Connecting…") }
                    default:
                        SecureField("Personal access token", text: $pat)
                        if case let .error(msg) = account.state {
                            Text(msg).font(.caption).foregroundStyle(.red)
                        }
                        Button("Connect") { Task { await account.connect(token: pat) } }
                            .disabled(pat.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
