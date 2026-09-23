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
                CloudLibraryScene(model: model)
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

/// Library window: receives `recto://document/<id>` and carries the web origin
/// into the status bar's globe button.
private struct CloudLibraryScene: View {
    let model: RectoApplicationModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        RectoCloudRootView(model: model)
            .environment(\.rectoWebOrigin, model.webURL)
            .onOpenURL { url in
                Task {
                    if await model.openDocument(from: url) {
                        openWindow(id: "cloud-library")
                    }
                }
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
        // The window toolbars no longer carry undo/redo (the web-parity
        // TopFormatToolbar already owns them), so the Edit menu answers ⌘Z
        // instead: the key window's host history where the host registered one,
        // else whatever the responder chain would have done with the key.
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") {
                UndoRedoCommands.perform(.undo, keyWindow: NSApp.keyWindow, editors: editors)
            }
            .keyboardShortcut("z")
            Button("Redo") {
                UndoRedoCommands.perform(.redo, keyWindow: NSApp.keyWindow, editors: editors)
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
        }
        CommandGroup(after: .toolbar) {
            Button(CommandPaletteController.placeholder) {
                palette.open(library: library)
            }
            .keyboardShortcut("k")
            Button("Open in web app") {
                model.openSelectedDocumentInWeb()
            }
            .disabled(!model.canOpenSelectedDocumentInWeb)
            Divider()
            // The ring's buttons carry these chords in-window; with the bar
            // hidden the ring is gone, and the menu is what answers them.
            Button("Switch to Rich text") { editors.choosePresentation(.rich, in: NSApp.keyWindow) }
                .keyboardShortcut("r", modifiers: [.control, .shift])
            Button("Switch to Raw Markdown") { editors.choosePresentation(.raw, in: NSApp.keyWindow) }
                .keyboardShortcut("m", modifiers: [.control, .shift])
            Button("Switch to Vim") { editors.choosePresentation(.vim, in: NSApp.keyWindow) }
                .keyboardShortcut("v", modifiers: [.control, .shift])
            Button("Switch to Preview") { editors.choosePresentation(.preview, in: NSApp.keyWindow) }
                .keyboardShortcut("p", modifiers: [.control, .shift])
            Button("Cycle mode forward") { editors.controller(in: NSApp.keyWindow)?.cyclePresentation(by: 1) }
                .keyboardShortcut("]", modifiers: [.control, .shift])
            Button("Cycle mode backward") { editors.controller(in: NSApp.keyWindow)?.cyclePresentation(by: -1) }
                .keyboardShortcut("[", modifiers: [.control, .shift])
            Divider()
            Button("Toggle zen mode") { editors.controller(in: NSApp.keyWindow)?.toggleZen() }
                .keyboardShortcut("f", modifiers: [.control, .shift])
            Button("Toggle body font (sans / serif)", action: settings.toggleReadingFont)
            Divider()
            Button("Toggle formatting toolbar", action: settings.toggleToolbar)
            Button("Toggle word count / status bar", action: settings.toggleStatusBar)
                .keyboardShortcut("s", modifiers: [.control, .shift])
            Button("Toggle typewriter scrolling", action: settings.toggleTypewriter)
                .keyboardShortcut("t", modifiers: [.control, .shift])
            Button("Toggle focus dimming", action: settings.toggleFocusDim)
                .keyboardShortcut("d", modifiers: [.control, .shift])
            Button("Toggle prose linter", action: settings.toggleLint)
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
            },
            openInWeb: { [model] in
                model.openSelectedDocumentInWeb()
            },
            canOpenInWeb: model.canOpenSelectedDocumentInWeb
        )
    }
}

/// The Edit menu's undo/redo dispatch: the key window's editor host owns the
/// history when there is one (the cloud document through its session, the file
/// document through its `GroupClosingUndoManager` — the same manager the
/// responder chain would find, so the standard path keeps working too); a
/// window without a host falls through to the responder chain, so undo in a
/// first-responder anything else (a Settings text field, say) is unchanged.
@MainActor
enum UndoRedoCommands {
    enum Direction {
        case undo
        case redo
    }

    /// The selectors the standard menu items send; kept nameable so a test can
    /// pin that the fallback is the stock chain, not a private path.
    static let undoSelector = #selector(UndoManager.undo)
    static let redoSelector = #selector(UndoManager.redo)

    /// `true` when a host's history handled the key, `false` when the action
    /// went to the responder chain.
    @discardableResult
    static func perform(
        _ direction: Direction, keyWindow: NSWindow?, editors: EditorHostRegistry
    ) -> Bool {
        if let chrome = editors.controller(in: keyWindow) {
            switch direction {
            case .undo: chrome.undo()
            case .redo: chrome.redo()
            }
            return true
        }
        NSApp.sendAction(
            direction == .undo ? undoSelector : redoSelector,
            to: nil, from: nil)
        return false
    }
}
