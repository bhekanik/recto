import AppKit
import RectoEditor

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
        // and from then on trusts NSTextView's own toggle actions: it snapshots
        // them so that a caret leaving a code span restores the writer's choice
        // rather than the launch default. Going through the same actions keeps
        // that snapshot right.
        if textView.isContinuousSpellCheckingEnabled != settings.spellcheck {
            textView.toggleContinuousSpellChecking(nil)
        }
        if textView.isGrammarCheckingEnabled != settings.spellcheck {
            textView.toggleGrammarChecking(nil)
        }
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
}
