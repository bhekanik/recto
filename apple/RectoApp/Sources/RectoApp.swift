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
            StudioAppearance(settings: settings) {
                RectoSettingsView(settings: settings)
            }
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
        // Right after Save, so ⌘S reaches Save in a file document's window
        // (Save is enabled there and first) and the checkpoint in the synced
        // library's (where Save has no document and is disabled).
        // ⌘N makes what the palette's New document makes: a synced document
        // when signed in, a Markdown file otherwise; ⌥⌘N is always a file.
        CommandGroup(replacing: .newItem) {
            Button("New document") { perform("new-document") }
                .keyboardShortcut("n")
            Button("New Markdown file") { NSDocumentController.shared.newDocument(nil) }
                .keyboardShortcut("n", modifiers: [.command, .option])
        }
        // The web's document-scope copy and export chords.
        CommandGroup(after: .pasteboard) {
            Divider()
            Button("Copy as rich text") { perform("copy-rich") }
                .keyboardShortcut("c", modifiers: [.command, .shift])
            Button("Copy as Markdown") { perform("copy-markdown") }
                .keyboardShortcut("c", modifiers: [.command, .option])
            Button("Export…") { palette.open(library: library, query: "Export as") }
                .keyboardShortcut("e", modifiers: [.control, .shift])
        }
        SidebarCommands()
        CommandGroup(after: .sidebar) {
            Button("Go to document list") {
                openWindow(id: "cloud-library")
                model.request(.focusDocuments)
            }
            .keyboardShortcut("1", modifiers: [.control, .command])
            .disabled(!isSignedIn)
            Button("Go to editor") {
                if isSignedIn, editors.libraryWindow === NSApp.keyWindow {
                    model.request(.focusEditor)
                } else {
                    editors.controller(in: NSApp.keyWindow)?.focusText()
                }
            }
            .keyboardShortcut("2", modifiers: [.control, .command])
            Button("Search documents") {
                openWindow(id: "cloud-library")
                model.request(.focusSearch)
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(!isSignedIn)
            Button("Go to heading…") { perform("go-to-heading") }
                .keyboardShortcut("o", modifiers: [.control, .shift])
        }
        CommandMenu("Format") {
            ForEach(FormatToolbarAction.all) { action in
                formatButton(action)
            }
        }
        CommandGroup(after: .saveItem) {
            Button("Create version / checkpoint") { editors.controller(in: NSApp.keyWindow)?.checkpoint?() }
                .keyboardShortcut("s")
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
            Button("Split pane — vertical") { editors.controller(in: NSApp.keyWindow)?.panes?.split(.columns) }
                .keyboardShortcut("\\", modifiers: .command)
            Button("Split pane — horizontal") { editors.controller(in: NSApp.keyWindow)?.panes?.split(.rows) }
                .keyboardShortcut("\\", modifiers: [.command, .shift])
            Button("Close pane") { editors.controller(in: NSApp.keyWindow)?.panes?.close() }
                .keyboardShortcut("w", modifiers: [.control, .shift])
            Button("Focus next pane") { editors.controller(in: NSApp.keyWindow)?.panes?.focus(1) }
                .keyboardShortcut(.rightArrow, modifiers: [.control, .shift])
            Button("Focus previous pane") { editors.controller(in: NSApp.keyWindow)?.panes?.focus(-1) }
                .keyboardShortcut(.leftArrow, modifiers: [.control, .shift])
            Divider()
            Button("Open undo-tree visualizer") { editors.controller(in: NSApp.keyWindow)?.openHistory?(.tree) }
                .keyboardShortcut("u", modifiers: [.control, .shift])
            Button("Open version history") { editors.controller(in: NSApp.keyWindow)?.openHistory?(.versions) }
                .keyboardShortcut("h", modifiers: [.control, .shift])
            Divider()
            Button("Transform selection with AI…") { editors.controller(in: NSApp.keyWindow)?.ai?.transform() }
                .keyboardShortcut("i", modifiers: [.control, .shift])
                .disabled(!settings.aiEnabled)
            Button("AI review (comments)…") { editors.controller(in: NSApp.keyWindow)?.ai?.critique() }
                .keyboardShortcut("j", modifiers: [.control, .shift])
                .disabled(!settings.aiEnabled)
            Button("Related passages from past drafts…") { editors.controller(in: NSApp.keyWindow)?.ai?.related() }
                .keyboardShortcut("k", modifiers: [.control, .shift])
                .disabled(!settings.aiEnabled)
            Divider()
            Button("Toggle zen mode") { editors.controller(in: NSApp.keyWindow)?.toggleZen() }
                .keyboardShortcut("f", modifiers: [.control, .shift])
            Button("Toggle body font (sans / serif)", action: settings.toggleReadingFont)
            Divider()
            Button("Toggle formatting toolbar", action: settings.toggleToolbar)
            Button("Toggle word count / status bar", action: settings.toggleStatusBar)
                .keyboardShortcut("s", modifiers: [.control, .shift])
            Button("Toggle quiet chrome while typing", action: settings.toggleQuietChrome)
            Button("Toggle page sheet", action: settings.toggleSheet)
            Button("Toggle compact status bar", action: settings.toggleCompactStatusBar)
            Button("Toggle typewriter scrolling", action: settings.toggleTypewriter)
                .keyboardShortcut("t", modifiers: [.control, .shift])
            Button("Toggle focus dimming", action: settings.toggleFocusDim)
                .keyboardShortcut("d", modifiers: [.control, .shift])
            Button("Toggle focus blur", action: settings.toggleFocusBlur)
                .keyboardShortcut("b", modifiers: [.control, .shift])
            Button("Toggle prose linter", action: settings.toggleLint)
            Divider()
            // Writing flags: a note at the caret, and the panel that lists them.
            Button("Flag this spot…") { editors.controller(in: NSApp.keyWindow)?.addFlag() }
                .keyboardShortcut("x", modifiers: [.command, .shift])
            Button("Toggle notes panel") { editors.controller(in: NSApp.keyWindow)?.notes.toggle(settings) }
                .keyboardShortcut("n", modifiers: [.control, .shift])
            Button("Pin notes panel open", action: settings.toggleNotesPinned)
            Divider()
            Button("Toggle spellcheck", action: settings.toggleSpellcheck)
                .keyboardShortcut(";")
            Divider()
            // The system's zoom chords, as browsers and Pages use them.
            Button("Increase text size", action: settings.zoomIn)
                .keyboardShortcut("=")
            Button("Decrease text size", action: settings.zoomOut)
                .keyboardShortcut("-")
            Button("Reset text size", action: settings.zoomReset)
                .keyboardShortcut("0")
        }
    }

    /// A palette command from a menu chord, against the key window's editor.
    private func perform(_ id: String) {
        palette.perform(id, editor: editors.controller(in: NSApp.keyWindow), library: library)
    }

    private var isSignedIn: Bool {
        if case .signedIn = model.authStatus { true } else { false }
    }

    @ViewBuilder
    private func formatButton(_ action: FormatToolbarAction) -> some View {
        let button = Button(action.label) {
            editors.controller(in: NSApp.keyWindow)?.format(action.command)
        }
        if let (key, modifiers) = action.shortcut {
            button.keyboardShortcut(KeyEquivalent(key), modifiers: modifiers)
        } else {
            button
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
                model.request(.focusEditor)
            },
            create: { [model] in
                openWindow(id: "cloud-library")
                Task { await model.createDocument() }
            },
            openInWeb: { [model] in
                model.openSelectedDocumentInWeb()
            },
            canOpenInWeb: model.canOpenSelectedDocumentInWeb,
            focusDocuments: { [model] in
                openWindow(id: "cloud-library")
                model.request(.focusDocuments)
            },
            focusEditor: { [model] in model.request(.focusEditor) },
            toggleSidebar: { [model] in model.request(.toggleSidebar) },
            focusSearch: { [model] in
                openWindow(id: "cloud-library")
                model.request(.focusSearch)
            },
            signOut: { [model] in Task { await model.signOut() } }
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
