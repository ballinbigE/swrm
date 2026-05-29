import SwiftUI
import SwrmUI

struct WhatsNewView: View {
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            SwrmTheme.charcoal.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 24) {
                Text(WhatsNew.title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(SwrmTheme.honey)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 16) {
                    ForEach(WhatsNew.items, id: \.self) { item in
                        Text(item)
                            .font(.body)
                            .foregroundStyle(SwrmTheme.cream)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer()

                Button(action: onDismiss) {
                    Text("Got it")
                        .font(.headline)
                        .foregroundStyle(SwrmTheme.charcoal)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(SwrmTheme.honey)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
            .padding(28)
        }
        .frame(minWidth: 340, minHeight: 380)
    }
}
