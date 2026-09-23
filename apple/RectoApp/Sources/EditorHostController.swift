import AppKit
import RectoEditor
import RectoSync
import SwiftUI

/// What a synced document's editor can say to the server beyond sync: the
/// function-call surface and the document's server id, which stays `nil`
/// until the first sync publishes it.
struct CloudDocumentContext {
    let api: any RectoAPI
    let convexId: String?
}

/// What one editor host owns around the text: the writing controls, find,
/// typewriter scrolling, the settings that live on the text view itself, and
/// the targets the formatting toolbar dispatches to.
@MainActor
final class EditorHostController {
    let settings: StudioSettings
    let writingController = RectoWritingController()
    let find = RectoFindController()
    let typewriter: RectoTypewriterController
    /// Set by the host: the file document undoes through its `UndoManager`,
    /// the cloud document through its session.
    var undo: () -> Void = {}
    var redo: () -> Void = {}
    /// Set by the host: the lens is this window's own, so a mode switch from
    /// the palette lands on the window it was pressed in.
    var choosePresentation: (Presentation) -> Void = { _ in }
    /// Set by the synced host. `nil` for a file document, which is local.
    var cloud: CloudDocumentContext?
    private(set) var seam: RectoTextView?
    private let registry: EditorHostRegistry

    init(settings: StudioSettings, registry: EditorHostRegistry = .shared) {
        self.settings = settings
        self.registry = registry
        typewriter = RectoTypewriterController(isEnabled: settings.typewriter)
    }

    /// `RectoEditorView.onAttach`.
    func attach(_ seam: RectoTextView?) {
        self.seam = seam
        find.attach(to: seam)
        typewriter.attach(to: seam)
        applySettings()
        if seam == nil { registry.remove(self) } else { registry.add(self) }
    }

    /// The window this editor is on screen in, while it is.
    var window: NSWindow? { seam?.nsTextView?.window }

    /// The document as the editor holds it. Markers are hidden by font size,
    /// not removed, so the view's string is the Markdown source in every
    /// presentation.
    var markdown: String? { seam?.text }

    /// Push the settings that reach into the live text view. Run on attach and
    /// whenever spellcheck or typewriter change.
    func applySettings() {
        typewriter.isEnabled = settings.typewriter
        guard let textView = seam?.nsTextView else { return }
        // The engine reads its spellcheck policy once, when it builds the view,
        // and from then on keeps a snapshot it takes after each of NSTextView's
        // toggle actions; a caret leaving a code span restores that snapshot,
        // not the launch default. The view's live value is not the snapshot —
        // inside a span the engine has forced it off — so the toggles run
        // whether or not the view already agrees: twice when it does, which
        // leaves the view as it was and the snapshot equal to the setting.
        Self.drive(textView.isContinuousSpellCheckingEnabled, to: settings.spellcheck) {
            textView.toggleContinuousSpellChecking(nil)
        }
        Self.drive(textView.isGrammarCheckingEnabled, to: settings.spellcheck) {
            textView.toggleGrammarChecking(nil)
        }
    }

    private static func drive(_ current: Bool, to wanted: Bool, toggle: () -> Void) {
        toggle()
        if current == wanted { toggle() }
    }

    /// A toolbar button. Link needs a destination, so it opens the same
    /// popover the selection bar uses; everything else runs directly.
    func format(_ command: RectoEditorCommand) {
        if case .link = command {
            WritingControlsHost.showLinkInput(for: writingController)
        } else {
            writingController.perform(command)
        }
    }

    var formatToolbarActions: FormatToolbarActions {
        FormatToolbarActions(
            undo: { [weak self] in self?.undo() },
            redo: { [weak self] in self?.redo() },
            format: { [weak self] command in self?.format(command) }
        )
    }

    /// The web's ⌘F opens find & replace; the find bar's replace field is the
    /// native form of that, when the text can be edited.
    func showFindAndReplace() {
        let action: NSTextFinder.Action = find.validateTextFinderAction(.showReplaceInterface)
            ? .showReplaceInterface
            : .showFindInterface
        find.performTextFinderAction(action)
    }
}

/// The editors currently on screen, so an app-wide surface (the command
/// palette) can find the one in a given window. Weak: a host that goes away
/// without detaching costs nothing.
@MainActor
final class EditorHostRegistry {
    static let shared = EditorHostRegistry()

    private let controllers = NSHashTable<EditorHostController>.weakObjects()

    func add(_ controller: EditorHostController) {
        controllers.add(controller)
    }

    func remove(_ controller: EditorHostController) {
        controllers.remove(controller)
    }

    func controller(in window: NSWindow?) -> EditorHostController? {
        guard let window else { return nil }
        return controllers.allObjects.first { $0.window === window }
    }

    /// The window `Window("Recto", id: "cloud-library")` is on screen in, for
    /// surfaces that need a home when the key window has no editor.
    weak var libraryWindow: NSWindow?

    /// The View menu's mode chords: switch the lens of the editor in `window`.
    func choosePresentation(_ presentation: Presentation, in window: NSWindow?) {
        controller(in: window)?.choosePresentation(presentation)
    }

    /// The window an app-wide surface should sit over when `keyWindow` is key:
    /// the window itself when it holds an editor; its host when it is a child
    /// (the link-input popover, the selection bar); else the library window;
    /// else nothing.
    func surfaceWindow(for keyWindow: NSWindow?) -> NSWindow? {
        var candidate = keyWindow
        while let window = candidate {
            if controller(in: window) != nil { return window }
            candidate = window.parent
        }
        return libraryWindow
    }
}

/// Records the window the library root lands in, for
/// ``EditorHostRegistry/libraryWindow``.
struct LibraryWindowAnchor: NSViewRepresentable {
    let editors: EditorHostRegistry

    func makeNSView(context: Context) -> AnchorView {
        AnchorView(editors: editors)
    }

    func updateNSView(_ nsView: AnchorView, context: Context) {}

    final class AnchorView: NSView {
        private let editors: EditorHostRegistry

        init(editors: EditorHostRegistry) {
            self.editors = editors
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { editors.libraryWindow = window }
        }
    }
}
