import SwiftUI

@main
struct RectoApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = RectoApplicationModel()
    private let settings = StudioSettings.shared

    var body: some Scene {
        Window("Recto", id: "cloud-library") {
            StudioAppearance(settings: settings) {
                RectoCloudRootView(model: model)
                    .onChange(of: scenePhase) { _, phase in
                        Task {
                            if phase == .active {
                                await model.enterForeground()
                            } else {
                                await model.leaveActive()
                            }
                        }
                    }
            }
        }
        .defaultSize(width: 1_100, height: 760)
        .windowResizability(.contentMinSize)
        .commands { StudioCommands(settings: settings) }

        DocumentGroup(newDocument: RectoDocument()) { configuration in
            StudioAppearance(settings: settings) {
                EditorHostView(
                    document: configuration.$document,
                    isEditable: configuration.isEditable,
                    settings: settings
                )
            }
        }
        .defaultSize(width: 1_000, height: 720)
        .windowResizability(.contentMinSize)

        Settings {
            RectoSettingsView()
        }
    }
}

/// Puts a window on the writer's chosen appearance so its chrome matches the
/// editor's palette. A view rather than a modifier in `App.body`, so the
/// settings read is observed.
private struct StudioAppearance<Content: View>: View {
    let settings: StudioSettings
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .preferredColorScheme(settings.preferredColorScheme)
    }
}

/// The View menu's studio toggles. The web's chords for the status bar and
/// typewriter live here rather than on the status-bar buttons, because hiding
/// the bar would take the chord that brings it back with it.
private struct StudioCommands: Commands {
    let settings: StudioSettings

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("Toggle formatting toolbar", action: settings.toggleToolbar)
            Button("Toggle word count / status bar", action: settings.toggleStatusBar)
                .keyboardShortcut("s", modifiers: [.control, .shift])
            Button("Toggle typewriter scrolling", action: settings.toggleTypewriter)
                .keyboardShortcut("t", modifiers: [.control, .shift])
            Button("Toggle spellcheck", action: settings.toggleSpellcheck)
            Divider()
            Button("Increase text size", action: settings.zoomIn)
            Button("Decrease text size", action: settings.zoomOut)
            Button("Reset text size", action: settings.zoomReset)
        }
    }
}
