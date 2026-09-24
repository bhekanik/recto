import SwiftUI

/// Settings › General: which app opens Markdown files, and the AI switch.
struct GeneralSettingsTab: View {
    @Bindable var settings: StudioSettings
    @State private var markdownHandler = MarkdownHandlerSettings()

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    HStack(spacing: 10) {
                        if markdownHandler.isRectoDefault {
                            Label("Recto", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .accessibilityLabel("Recto is the default")
                        } else {
                            Text(markdownHandler.defaultApplicationName ?? "No app")
                                .foregroundStyle(.secondary)
                            Button("Use Recto") {
                                Task { await markdownHandler.makeRectoDefault() }
                            }
                            .disabled(markdownHandler.isUpdating)
                        }
                    }
                } label: {
                    SettingLabel(
                        title: "Opens Markdown files",
                        caption: "The app that opens a .md file from Finder.",
                        symbol: "doc.text", tint: .blue)
                }
                if let errorMessage = markdownHandler.errorMessage {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Markdown files")
            }

            Section {
                // Turning AI on asks for consent against a synced document, so
                // it starts from a document; here it can only be turned off.
                if settings.aiEnabled {
                    Toggle(isOn: $settings.aiEnabled) {
                        SettingLabel(
                            title: "AI features",
                            caption: "Transform a selection, review a draft, and find related passages.",
                            symbol: "sparkles", tint: .purple)
                    }
                    Toggle(isOn: reviewAIChanges) {
                        SettingLabel(
                            title: "Review changes before they apply",
                            caption: "Show each AI edit with Keep and Reject instead of applying it.",
                            symbol: "checkmark.rectangle.stack", tint: .purple)
                    }
                } else {
                    LabeledContent {
                        Text("Off").foregroundStyle(.secondary)
                    } label: {
                        SettingLabel(
                            title: "AI features",
                            caption: "Turn them on from a synced document: ⌘K, then “Toggle AI features”. Recto asks for consent first.",
                            symbol: "sparkles", tint: .purple)
                    }
                }
            } header: {
                Text("AI")
            }
        }
        .settingsForm()
    }

    private var reviewAIChanges: Binding<Bool> {
        Binding(
            get: { settings.aiTransformMode == .pending },
            set: { settings.aiTransformMode = $0 ? .pending : .replace })
    }
}
