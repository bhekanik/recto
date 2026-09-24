import AppKit
import RectoCoreJS
import RectoEditor
import RectoStore
import SwiftUI

/// The signed-in library as the palette sees it: what to list, and how to open
/// or create a document there. Empty while signed out, or while a file
/// document is the only thing open.
struct PaletteLibrary {
    var isSignedIn = false
    var documents: [DocumentRecord] = []
    var open: (String) -> Void = { _ in }
    var create: () -> Void = {}
    var openInWeb: () -> Void = {}
    /// Whether the selected cloud document can be opened in the web app: a
    /// convex id and a configured web URL. The palette hides the command
    /// otherwise, the way the web hides "Open in Recto app" off macOS — a
    /// dead palette entry would say nothing about why.
    var canOpenInWeb = false
    /// The library window's own keyboard moves.
    var focusDocuments: () -> Void = {}
    var focusEditor: () -> Void = {}
    var toggleSidebar: () -> Void = {}
    var signOut: () -> Void = {}
}

/// Opens the ⌘K palette over the key window and carries out what it picks.
///
/// The palette is a borderless child panel the size of the parent window's
/// content, rather than an overlay inside each SwiftUI root: one
/// implementation serves the library window, every document window and any
/// window that comes later; the panel takes key status so the search field
/// has the keyboard without the editor giving up its first responder; and
/// losing key status is the dismissal — a click anywhere else closes it. The
/// panel's SwiftUI content draws the web's scrim and card, so the layout is
/// the web's too.
@MainActor
final class CommandPaletteController {
    static let placeholder = "Search commands and documents…"
    static let maxWidth: CGFloat = 512

    private let settings: StudioSettings
    private let editors: EditorHostRegistry
    private let pasteboard: NSPasteboard
    private let goals: GoalConfigController
    private var panel: PalettePanel?
    /// The model the open panel shows, for the headings finder's tests; `nil`
    /// while no palette is up.
    private(set) var model: PaletteModel?
    private weak var parent: NSWindow?
    private var observers: [NSObjectProtocol] = []

    init(
        settings: StudioSettings,
        editors: EditorHostRegistry = .shared,
        pasteboard: NSPasteboard = .general,
        goals: GoalConfigController = .shared
    ) {
        self.settings = settings
        self.editors = editors
        self.pasteboard = pasteboard
        self.goals = goals
    }

    var isOpen: Bool { panel != nil }
    var panelWindow: NSWindow? { panel }

    /// Show the palette over the window ⌘K was pressed in — or over the window
    /// that hosts it when the key window is a popover, or over the library when
    /// the key window has no editor at all (Settings). A second ⌘K while it is
    /// up leaves it up, like the web.
    func open(over keyWindow: NSWindow? = NSApp.keyWindow, library: PaletteLibrary) {
        guard !isOpen, let window = editors.surfaceWindow(for: keyWindow) else { return }
        if window !== keyWindow { window.makeKeyAndOrderFront(nil) }
        let editor = editors.controller(in: window)
        let model = PaletteModel(
            sections: Self.sections(settings: settings, library: library, editor: editor),
            run: { [weak self] item in self?.run(item, editor: editor, library: library) },
            close: { [weak self] in self?.close() }
        )
        present(model: model, over: window)
    }

    /// `go-to-heading`: the palette again, listing only this document's
    /// headings (the web's headings scope). The command palette closes itself
    /// as soon as `perform` returns, so this is called on a later run-loop
    /// turn and never has to tear down the panel that asked for it.
    ///
    /// A document with no headings opens nothing — there is nothing to jump
    /// to, and an empty palette would only say so.
    func openHeadingFinder(over editor: EditorHostController, library: PaletteLibrary) async {
        guard !isOpen, let window = editor.window, let markdown = editor.markdown else { return }
        let headings: [OutlineHeading]
        do {
            headings = try await SharedRectoCore.core().parseOutline(markdown)
        } catch {
            ExportController.presentError("Couldn't read the outline.", error, window: window)
            return
        }
        guard !headings.isEmpty else { return }
        let items = headings.map { heading in
            PaletteItem(
                id: "heading-\(heading.index)",
                kind: .heading(heading),
                label: heading.text.isEmpty ? "(untitled heading)" : heading.text,
                detail: .text("H\(heading.depth)"),
                searchValue: "heading \(heading.text) h\(heading.depth)"
            )
        }
        let model = PaletteModel(
            sections: [PaletteSection(title: "Headings", items: items)],
            run: { [weak self] item in self?.run(item, editor: editor, library: library) },
            close: { [weak self] in self?.close() }
        )
        present(model: model, over: window)
    }

    /// The panel a palette lives in: the borderless key panel, sized over its
    /// parent and observing it. Both palettes — commands and headings — are
    /// the same panel, which is why there is never but one at a time.
    private func present(model: PaletteModel, over window: NSWindow) {
        let panel = PalettePanel(onCancel: { [weak self] in self?.close() })
        panel.appearance = NSAppearance(named: settings.resolvedAppearance == .dark ? .darkAqua : .aqua)
        panel.contentView = NSHostingView(rootView: CommandPaletteView(model: model, theme: settings.theme))
        self.panel = panel
        self.model = model
        parent = window
        layoutPanel()
        window.addChildWindow(panel, ordered: .above)
        panel.makeKeyAndOrderFront(nil)
        observe(panel: panel, parent: window)
    }

    /// Esc, Return, the scrim: take the palette down and hand the keyboard
    /// back to the window it came from. That window's first responder was
    /// never changed, so the editor resumes where it was.
    func close() {
        tearDown(restoringKey: true)
    }

    /// The panel lost key status. To another window: the writer chose that
    /// window, and it keeps the keyboard. To nothing (the app deactivated): the
    /// parent takes it back, so the app returns where it was.
    func paletteDidResignKey(to keyWindow: NSWindow?) {
        tearDown(restoringKey: keyWindow == nil || keyWindow === panel)
    }

    private func tearDown(restoringKey: Bool) {
        guard let panel else { return }
        self.panel = nil
        self.model = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        if restoringKey { parent?.makeKey() }
        parent = nil
    }

    // MARK: - Content

    /// The web's palette body: `SECTION_ORDER`, Documents first with "New
    /// document" then the library, and the dark-only theme hidden while the
    /// appearance resolves to light (Paper is the one light palette).
    /// `export-docx` needs a synced document with a convex id — the server
    /// exports its own markdown — so it is absent without one, the way the
    /// web hides "Open in Recto app" off macOS.
    static func sections(
        settings: StudioSettings,
        library: PaletteLibrary,
        editor: EditorHostController? = nil
    ) -> [PaletteSection] {
        CommandSection.allCases.compactMap { section in
            var actions = CommandRegistry.actions(in: section)
            if section == .theme, settings.resolvedAppearance == .light {
                actions = actions.filter { $0.id.hasPrefix("appearance-") }
            }
            // The history panel is the synced document's; a file has AppKit undo.
            if section == .history, editor?.openHistory == nil {
                actions.removeAll { ["checkpoint", "undo-tree", "version-history"].contains($0.id) }
            }
            // AI is opt-in: while it is off, or where there is no synced
            // document, the switch is the one AI command (the web's rule).
            if section == .ai, !settings.aiEnabled || editor?.ai == nil {
                actions = actions.filter { $0.id == "toggle-ai" }
            }
            // Sharing, comments and suggestions need the server.
            if section == .review, editor?.review == nil {
                actions.removeAll()
            }
            // Panes live in the library window; a file document's window has none.
            if section == .panes, editor?.panes == nil {
                actions.removeAll()
            }
            if section == .copyExport, editor?.cloud?.convexId == nil {
                actions.removeAll { $0.id == "export-docx" }
            }
            // The sidebar and the account are the library window's.
            if section == .documents, !library.isSignedIn {
                actions.removeAll { ["go-to-documents", "toggle-sidebar", "sign-out"].contains($0.id) }
            }
            if section == .documents, editor == nil {
                actions.removeAll { $0.id == "go-to-editor" }
            }
            // Formatting edits the text; preview and a window with no editor
            // have nothing to format.
            if section == .format,
               editor.map({ !$0.currentPresentation().isEditable }) ?? true {
                actions.removeAll()
            }
            var items = actions.map(PaletteItem.init(action:))
            if section == .documents {
                if !library.canOpenInWeb {
                    items.removeAll { $0.id == "open-in-web" }
                }
                if library.isSignedIn {
                    items += library.documents.map { document in
                        PaletteItem(
                            id: "document-\(document.localId)",
                            kind: .document(localId: document.localId),
                            label: document.title,
                            detail: .text("\(document.wordCount.formatted()) w"),
                            searchValue: "document \(document.title)"
                        )
                    }
                }
            }
            return items.isEmpty ? nil : PaletteSection(title: section.rawValue, items: items)
        }
    }

    private func run(_ item: PaletteItem, editor: EditorHostController?, library: PaletteLibrary) {
        switch item.kind {
        case let .action(id):
            perform(id, editor: editor, library: library)
        case let .document(localId):
            library.open(localId)
        case let .heading(heading):
            editor?.jump(toHeading: heading)
        }
    }

    /// The web's `createActionMap`, for the native subset. Returns `false` for
    /// an id the registry does not carry.
    @discardableResult
    func perform(_ id: String, editor: EditorHostController?, library: PaletteLibrary) -> Bool {
        switch id {
        case "go-to-documents":
            // After the palette's close hands the keyboard back, or that
            // hand-back would take it straight from the list again.
            Task { @MainActor in library.focusDocuments() }
        case "go-to-editor":
            Task { @MainActor [weak editor] in
                if library.isSignedIn, editor?.panes != nil {
                    library.focusEditor()
                } else {
                    editor?.focusText()
                }
            }
        case "toggle-sidebar":
            library.toggleSidebar()
        case "open-settings":
            Task { @MainActor in
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            }
        case "sign-out":
            library.signOut()
        case "toggle-lint":
            settings.toggleLint()
        case "toggle-quiet-chrome":
            settings.toggleQuietChrome()
        case let id where id.hasPrefix("format-"):
            guard let action = FormatToolbarAction.all.first(where: { "format-\($0.id)" == id }) else { return false }
            editor?.format(action.command)
        case "new-document":
            if library.isSignedIn {
                library.create()
            } else {
                NSDocumentController.shared.newDocument(nil)
            }
        case "open-in-web":
            library.openInWeb()
        case "mode-rich":
            editor?.choosePresentation(.rich)
        case "mode-raw":
            editor?.choosePresentation(.raw)
        case "mode-vim":
            editor?.choosePresentation(.vim)
        case "mode-preview":
            editor?.choosePresentation(.preview)
        case "cycle-next":
            editor?.cyclePresentation(by: 1)
        case "cycle-prev":
            editor?.cyclePresentation(by: -1)
        case "split-v":
            editor?.panes?.split(.columns)
        case "split-h":
            editor?.panes?.split(.rows)
        case "close-pane":
            editor?.panes?.close()
        case "focus-next":
            editor?.panes?.focus(1)
        case "focus-prev":
            editor?.panes?.focus(-1)
        case "checkpoint":
            // After the palette's close, so the name prompt is not modal over it.
            Task { @MainActor in editor?.checkpoint?() }
        case "undo-tree":
            editor?.openHistory?(.tree)
        case "version-history":
            editor?.openHistory?(.versions)
        case "manage-sharing":
            editor?.review?.openSharing()
        case "review-surface":
            editor?.review?.openReview()
        case "toggle-comments":
            editor?.review?.toggleComments()
        case "add-comment":
            editor?.review?.addComment()
        case "toggle-ai":
            if let toggle = editor?.ai?.toggle { toggle() } else { settings.aiEnabled.toggle() }
        case "toggle-transform-mode":
            settings.toggleAITransformMode()
        case "ai-transform":
            editor?.ai?.transform()
        case "ai-critique":
            editor?.ai?.critique()
        case "ai-related":
            editor?.ai?.related()
        case "ai-reindex":
            editor?.ai?.reindex()
        case "undo":
            editor?.undo()
        case "redo":
            editor?.redo()
        case "copy-markdown":
            guard let markdown = editor?.markdown else { return true }
            pasteboard.clearContents()
            pasteboard.setString(markdown, forType: .string)
        case "copy-rich":
            guard let editor, let markdown = editor.markdown else { return true }
            let window = editor.window
            Task { await ExportController.copyRich(markdown: markdown, pasteboard: pasteboard, window: window) }
        case "export-md":
            guard let editor, let markdown = editor.markdown else { return true }
            // Deferred past this palette's own close, so the save panel the
            // export opens is not modal on top of a palette that is about to
            // disappear — the web's download begins after the palette is gone.
            let title = editor.documentTitle
            let window = editor.window
            Task { @MainActor in
                ExportController.exportMarkdown(markdown: markdown, title: title, window: window)
            }
        case "export-html":
            guard let editor, let markdown = editor.markdown else { return true }
            let title = editor.documentTitle
            let window = editor.window
            Task { await ExportController.exportHtml(markdown: markdown, title: title, window: window) }
        case "export-docx":
            guard let editor,
                let cloud = editor.cloud,
                let convexId = cloud.convexId
            else { return true }
            let title = editor.documentTitle
            let window = editor.window
            Task { @MainActor in
                await ExportController.exportDocx(cloud: cloud, convexId: convexId, title: title, window: window)
            }
        case "find-replace":
            editor?.showFindAndReplace()
        case "go-to-heading":
            guard let editor else { return true }
            // Deferred so the command palette's own close (which runs the
            // moment this returns) is not the one that tears down the heading
            // finder the gesture is about to open.
            Task { @MainActor [weak self, weak editor] in
                guard let self, let editor else { return }
                await self.openHeadingFinder(over: editor, library: library)
            }
        case "toggle-outline":
            settings.toggleOutline()
        case "toggle-status":
            settings.toggleStatusBar()
        case "toggle-focus":
            editor?.toggleZen()
        case "toggle-font":
            settings.toggleReadingFont()
        case "toggle-lint-passive":
            settings.toggleLintCategory(.passive)
        case "toggle-lint-readability":
            settings.toggleLintCategory(.readability)
        case "toggle-lint-adverb":
            settings.toggleLintCategory(.adverb)
        case "toggle-lint-weasel":
            settings.toggleLintCategory(.weasel)
        case "toggle-focus-dim":
            settings.toggleFocusDim()
        case "cycle-dim-scope":
            settings.cycleFocusDimScope()
        case "toggle-smart-paste":
            settings.toggleSmartPaste()
        case "toggle-email-preview":
            settings.togglePreviewVariant()
        case "set-goal":
            // After the palette's own close, so the goal panel is not dismissed
            // by the key-window change that close makes.
            let window = editor?.window
            Task { @MainActor [goals] in goals.open(over: window) }
        case "toggle-goal-style":
            settings.toggleGoalStyle()
        case "toggle-goal-scope":
            settings.toggleGoalScope()
        case "zoom-in":
            settings.zoomIn()
        case "zoom-out":
            settings.zoomOut()
        case "zoom-reset":
            settings.zoomReset()
        case "toggle-spellcheck":
            settings.toggleSpellcheck()
        case "toggle-toolbar":
            settings.toggleToolbar()
        case "toggle-typewriter":
            settings.toggleTypewriter()
        case "appearance-system":
            settings.appearance = .system
        case "appearance-light":
            settings.appearance = .light
        case "appearance-dark":
            settings.appearance = .dark
        case "theme-twilight":
            settings.palette = .twilight
        case "theme-aurora":
            settings.palette = .aurora
        case "theme-dawn":
            settings.palette = .dawn
        case "theme-moonlit":
            settings.palette = .moonlit
        default:
            return false
        }
        return true
    }

    // MARK: - Window plumbing

    private func layoutPanel() {
        guard let panel, let parent, let contentView = parent.contentView else { return }
        let frame = parent.convertToScreen(contentView.convert(contentView.bounds, to: nil))
        panel.setFrame(frame, display: false)
    }

    private func observe(panel: PalettePanel, parent: NSWindow) {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.paletteDidResignKey(to: NSApp.keyWindow) }
            },
            center.addObserver(forName: NSWindow.willCloseNotification, object: parent, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            },
            center.addObserver(forName: NSWindow.didResizeNotification, object: parent, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.layoutPanel() }
            },
        ]
    }
}

/// Borderless, transparent, and able to take the keyboard — which a
/// borderless window refuses by default.
private final class PalettePanel: NSPanel {
    private let onCancel: () -> Void

    init(onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
        super.init(
            contentRect: .zero,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        // Moves with its parent only; a drag on the scrim must not detach it.
        isMovable = false
    }

    override var canBecomeKey: Bool { true }

    /// Escape, when the search field has not already taken it.
    override func cancelOperation(_ sender: Any?) {
        onCancel()
    }
}
