import AppKit
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
    private var panel: PalettePanel?
    private weak var parent: NSWindow?
    private var observers: [NSObjectProtocol] = []

    init(
        settings: StudioSettings,
        editors: EditorHostRegistry = .shared,
        pasteboard: NSPasteboard = .general
    ) {
        self.settings = settings
        self.editors = editors
        self.pasteboard = pasteboard
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
            sections: Self.sections(settings: settings, library: library),
            run: { [weak self] item in self?.run(item, editor: editor, library: library) },
            close: { [weak self] in self?.close() }
        )
        let panel = PalettePanel(onCancel: { [weak self] in self?.close() })
        panel.appearance = NSAppearance(named: settings.resolvedAppearance == .dark ? .darkAqua : .aqua)
        panel.contentView = NSHostingView(rootView: CommandPaletteView(model: model, theme: settings.theme))
        self.panel = panel
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
    static func sections(settings: StudioSettings, library: PaletteLibrary) -> [PaletteSection] {
        CommandSection.allCases.compactMap { section in
            var actions = CommandRegistry.actions(in: section)
            if section == .theme, settings.resolvedAppearance == .light {
                actions = actions.filter { $0.id.hasPrefix("appearance-") }
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
        }
    }

    /// The web's `createActionMap`, for the native subset. Returns `false` for
    /// an id the registry does not carry.
    @discardableResult
    func perform(_ id: String, editor: EditorHostController?, library: PaletteLibrary) -> Bool {
        switch id {
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
        case "undo":
            editor?.undo()
        case "redo":
            editor?.redo()
        case "copy-markdown":
            guard let markdown = editor?.markdown else { return true }
            pasteboard.clearContents()
            pasteboard.setString(markdown, forType: .string)
        case "find-replace":
            editor?.showFindAndReplace()
        case "toggle-status":
            settings.toggleStatusBar()
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
            // Twilight is the only dark palette, so it is already in force
            // whenever this item is offered; the web's setTheme is a no-op then too.
            break
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
