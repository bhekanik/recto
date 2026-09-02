import AppKit
import SwiftUI

@main
struct RectoApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = RectoApplicationModel()
    private let settings = StudioSettings.shared
    private let palette = CommandPaletteController(settings: .shared)

    var body: some Scene {
        Window("Recto", id: "cloud-library") {
            StudioAppearance(settings: settings) {
                RectoCloudRootView(model: model)
                    .background(LibraryWindowAnchor(editors: .shared))
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
        .commands { StudioCommands(settings: settings, palette: palette, model: model, editors: .shared) }

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
            .onAppear(perform: settings.followApplicationAppearance)
    }
}

/// The View menu's studio entries: the ⌘K palette and the toggles. The web's
/// chords for the status bar and typewriter live here rather than on the
/// status-bar buttons, because hiding the bar would take the chord that brings
/// it back with it.
private struct StudioCommands: Commands {
    let settings: StudioSettings
    let palette: CommandPaletteController
    let model: RectoApplicationModel
    let editors: EditorHostRegistry
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button(CommandPaletteController.placeholder) {
                palette.open(library: library)
            }
            .keyboardShortcut("k")
            Divider()
            // The ring's buttons carry these chords in-window; with the bar
            // hidden the ring is gone, and the menu is what answers them.
            Button("Switch to Rich text") { editors.choosePresentation(.rich, in: NSApp.keyWindow) }
                .keyboardShortcut("r", modifiers: [.control, .shift])
            Button("Switch to Raw Markdown") { editors.choosePresentation(.raw, in: NSApp.keyWindow) }
                .keyboardShortcut("m", modifiers: [.control, .shift])
            Divider()
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

    /// The signed-in library for the palette's Documents section. Opening or
    /// creating there brings the library window forward, since ⌘K may have
    /// been pressed in a file document's window.
    private var library: PaletteLibrary {
        guard case .signedIn = model.authStatus else { return PaletteLibrary() }
        return PaletteLibrary(
            isSignedIn: true,
            documents: model.documents,
            open: { [model] localId in
                model.selectedDocumentId = localId
                openWindow(id: "cloud-library")
            },
            create: { [model] in
                openWindow(id: "cloud-library")
                Task { await model.createDocument() }
            }
        )
    }
}
