import SwiftUI

struct RectoSettingsView: View {
    @State private var markdownHandler = MarkdownHandlerSettings()

    var body: some View {
        Form {
            Section("Markdown files") {
                LabeledContent("Opens with") {
                    HStack {
                        Text(markdownHandler.defaultApplicationName ?? "No app")
                        if markdownHandler.isRectoDefault {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.green)
                                .accessibilityLabel("Recto is the default")
                        }
                    }
                }
                Button("Use Recto") {
                    Task { await markdownHandler.makeRectoDefault() }
                }
                .disabled(markdownHandler.isRectoDefault || markdownHandler.isUpdating)
                if let errorMessage = markdownHandler.errorMessage {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
    }
}
