import AppKit
import Foundation
import MarkdownEngine
import RectoCore
import RectoEditor
import SwiftUI

struct EditorHostView: View {
    @Binding private var document: RectoDocument
    @State private var storage: RectoTextStorage
    @StateObject private var history: DocumentUndoHistory
    @State private var chrome: EditorHostController
    @State private var vim = VimHostState()
    @State private var zen = ZenMode()
    @State private var wordCount = DocumentWordCount()
    @State private var lint = ProseLint()
    @AppStorage(PresentationPreference.key) private var storedPresentation: String?
    /// This window's lens. `nil` until it appears, when it takes the stored
    /// default; after that only the writer's own choice moves it.
    @State private var chosenPresentation: Presentation?
    private let settings: StudioSettings
    private let isEditable: Bool

    init(document: Binding<RectoDocument>, isEditable: Bool, settings: StudioSettings = .shared) {
        self.init(
            document: document,
            isEditable: isEditable,
            storage: RectoTextStorage(
                documentId: UUID().uuidString,
                markdown: document.wrappedValue.markdown
            ),
            settings: settings
        )
    }

    init(document: Binding<RectoDocument>, isEditable: Bool = true,
         storage: RectoTextStorage, settings: StudioSettings = .shared) {
        _document = document
        self.isEditable = isEditable
        self.settings = settings
        _storage = State(initialValue: storage)
        _history = StateObject(wrappedValue: DocumentUndoHistory(
            document: document,
            storage: storage
        ))
        _chrome = State(initialValue: EditorHostController(settings: settings))
    }

    private var presentation: Presentation {
        PresentationPreference.presentation(
            chosen: chosenPresentation,
            stored: storedPresentation,
            isEditable: isEditable
        )
    }

    private func choose(_ presentation: Presentation) {
        chosenPresentation = presentation
        if PresentationPreference.isStorable(presentation) {
            storedPresentation = presentation.rawValue
        }
    }

    private func toolbar(_ styler: MarkdownStyler) -> some View {
        TopFormatToolbar(
            theme: styler.theme,
            presentation: styler.presentation,
            actions: chrome.formatToolbarActions
        )
    }

    private func statusBar(_ styler: MarkdownStyler) -> some View {
        EditorStatusBar(
            presentation: styler.presentation,
            isEditable: isEditable,
            wordCount: wordCount,
            settings: settings,
            theme: styler.theme,
            stats: .shared,
            onOpenGoalConfig: { [chrome] in GoalConfigController.shared.open(over: chrome.window) },
            vimController: vim.controller,
            lint: lint,
            zen: zen,
            onToggleZen: chrome.toggleZen,
            onSelect: choose
        )
    }

    var body: some View {
        let styler = settings.styler(presentation: presentation)
        VStack(spacing: 0) {
            if settings.showToolbar, !zen.hidesChrome {
                toolbar(styler)
            }
            if styler.presentation == .preview, settings.previewVariant == .email {
                EmailPreviewChrome(
                    frontmatter: storage.frontmatter, fallbackTitle: chrome.documentTitle, theme: styler.theme)
            }
            HStack(spacing: 0) {
                RectoEditorView(
                    storage: storage,
                    styler: styler,
                    placeholder: "Start writing…",
                    onAttach: { seam in
                        chrome.attach(seam)
                        vim.sync(seam: seam, presentation: presentation)
                    },
                    onEdit: history.accept,
                    writingController: chrome.writingController
                )
                .frame(minWidth: 720, minHeight: 540)
                .background(WritingControlsHost(controller: chrome.writingController))
                if settings.showOutline, !zen.hidesChrome {
                    OutlinePanel(
                        storage: storage,
                        theme: styler.theme,
                        jump: { [chrome] heading in chrome.jump(toHeading: heading) },
                        close: { [settings] in settings.toggleOutline() }
                    )
                }
            }
            if settings.showStatusBar, !zen.hidesChrome {
                statusBar(styler)
            }
        }
        .modifier(ZenChrome(zen: zen, settings: settings, toolbar: toolbar(styler), statusBar: statusBar(styler)))
        .background { WordCountTracker(storage: storage, count: wordCount) }
        .background {
            LintTracker(
                storage: storage, settings: settings, decorations: chrome.decorations,
                result: lint, isLintable: presentation != .preview)
        }
        .onAppear {
            if chosenPresentation == nil {
                chosenPresentation = PresentationPreference.choice(from: storedPresentation)
            }
            history.attach(authoritativeMarkdown: document.markdown)
            chrome.undo = { [history] in history.undoManager.undo() }
            chrome.redo = { [history] in history.undoManager.redo() }
            chrome.choosePresentation = choose
            chrome.currentPresentation = { presentation }
            chrome.zen = zen
            chrome.documentTitle = RectoDocumentTitle.derive(document.markdown)
            vim.controller.history = history
            vim.controller.typewriter = chrome.typewriter
            vim.controller.onSave = {
                // The document menu's Save, through the responder chain, so
                // `:w` and ⌘S are the same action.
                NSApp.sendAction(#selector(NSDocument.save(_:)), to: nil, from: nil)
            }
        }
        .onDisappear {
            zen.leave()
            vim.sync(seam: nil, presentation: presentation)
            history.detach()
        }
        .onChange(of: presentation) { _, presentation in
            vim.sync(seam: storage.textView, presentation: presentation)
            chrome.applySettings()
        }
        .onChange(of: ExactMarkdown(document.markdown)) { _, markdown in
            history.adoptExternal(markdown.value)
            chrome.documentTitle = RectoDocumentTitle.derive(markdown.value)
        }
        .onChange(of: settings.spellcheck) { chrome.applySettings() }
        .onChange(of: settings.focusDim) { chrome.applySettings() }
        .onChange(of: settings.focusDimScope) { chrome.applySettings() }
        .onChange(of: settings.theme) { chrome.applySettings() }
        .onChange(of: settings.typewriter) { chrome.applySettings() }
    }
}

/// The vim layer's app-side lifetime: attach it when the editor is on screen in
/// `.vim`, detach otherwise, and carry registers and marks across sessions.
///
/// Shared by both document hosts, which call `sync` on attach, on a
/// presentation change and on disappear.
@MainActor
@Observable
final class VimHostState {
    let controller = RectoVimController()

    /// Vim's registers and marks, JSON from `saveState`. Global rather than
    /// per document: that is vim's own model (`"a` yanked in one buffer pastes
    /// in another).
    @ObservationIgnored
    private var registers: String {
        get { UserDefaults.standard.string(forKey: Self.registersKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: Self.registersKey) }
    }
    private static let registersKey = "vim.registers"

    /// Call whenever the editor seam or the presentation changes.
    func sync(seam: RectoTextView?, presentation: Presentation) {
        if let seam, seam.isAttached, presentation == .vim {
            attach(seam)
        } else {
            detach()
        }
    }

    private func attach(_ seam: RectoTextView) {
        let wasAttached = controller.isAttached
        controller.attach(to: seam)
        if !wasAttached, controller.isAttached, !registers.isEmpty {
            controller.restoreState(registers)
        }
    }

    private func detach() {
        guard controller.isAttached else { return }
        if let saved = controller.saveState() { registers = saved }
        controller.attach(to: nil)
    }
}

private struct ExactMarkdown: Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.value as NSString).isEqual(to: rhs.value)
    }
}

/// Edit › Undo reaches `undo()` straight from the responder chain, not through
/// `RectoEditorHistory.performHistory`. With a vim insert session's group still
/// open, `NSUndoManager.undo()` raises "undo was called with too many nested
/// undo groups"; closing the group first also makes menu Undo remove the whole
/// session, as `u` does.
final class GroupClosingUndoManager: UndoManager {
    /// AppKit drives undo managers on the main thread, so the hook runs there.
    var willNavigate: (@MainActor () -> Void)?
    /// After `super.undo()/redo()` returns: every `didChange` the navigation
    /// posted has been delivered (the restore closures run synchronously).
    var didNavigate: (@MainActor () -> Void)?

    override func undo() {
        MainActor.assumeIsolated { willNavigate?() }
        super.undo()
        MainActor.assumeIsolated { didNavigate?() }
    }

    override func redo() {
        MainActor.assumeIsolated { willNavigate?() }
        super.redo()
        MainActor.assumeIsolated { didNavigate?() }
    }
}

@MainActor
final class DocumentUndoHistory: ObservableObject, RectoEditorHistory {
    // Bound V1's full-string snapshots until model history replaces this owner.
    private static let snapshotLimit = 100

    let undoManager = GroupClosingUndoManager()

    private let storage: RectoTextStorage
    private let writeDocument: (String) -> Void
    private var currentMarkdown: String

    init(document: Binding<RectoDocument>, storage: RectoTextStorage) {
        self.storage = storage
        undoManager.levelsOfUndo = Self.snapshotLimit
        currentMarkdown = document.wrappedValue.markdown
        writeDocument = { markdown in
            guard !(document.wrappedValue.markdown as NSString).isEqual(to: markdown) else { return }
            var updated = document.wrappedValue
            updated.markdown = markdown
            document.wrappedValue = updated
        }
        storage.controller.undoManager = undoManager
        undoManager.willNavigate = { [unowned self] in
            // Menu Undo/Redo closes vim's group from outside; vim keeps its own
            // flag describing that group, so tell it the session is over before
            // the navigation's change lands.
            if openCommandGroup != nil { onExternalHistoryNavigation?() }
            endCommandGroup()
        }
        undoManager.didNavigate = { [unowned self] in
            // The popped group's closures run one didChange each; only now can
            // vim stop treating the storage churn as navigation aftermath.
            onExternalHistoryNavigationEnded?()
        }
    }

    func attach(authoritativeMarkdown: String) {
        adoptExternal(authoritativeMarkdown)
        storage.controller.undoManager = undoManager
    }

    func detach() {
        endCommandGroup()
        undoManager.removeAllActions()
        if storage.controller.undoManager === undoManager {
            storage.controller.undoManager = nil
        }
    }

    func accept(_ markdown: String) {
        accept(RectoEditorEdit(markdown: markdown, structural: false))
    }

    func accept(_ edit: RectoEditorEdit) {
        let markdown = edit.markdown
        guard !(currentMarkdown as NSString).isEqual(to: markdown) else { return }
        registerStep(restoring: currentMarkdown, actionName: edit.structural ? "Format" : "Edit")
        currentMarkdown = markdown
        writeDocument(markdown)
    }

    /// Every step is an explicit group. Left to `groupsByEvent`, AppKit opens
    /// a group at the first registration of a run-loop pass and closes it at
    /// the end, so two steps registered in one pass (a test, or a command that
    /// edits and then opens an insert session) collapse into one, and an
    /// explicit group opened inside it undoes together with whatever preceded
    /// it. Registrations made while undoing or redoing join the manager's own
    /// group for that operation.
    private func registerStep(restoring previous: String, actionName: String) {
        let navigating = undoManager.isUndoing || undoManager.isRedoing
        if !navigating {
            if openCommandGroup != nil {
                // An open command group materialises at its first edit, not at
                // `beginCommandGroup`: an empty NSUndoManager group is still an
                // undo step, and closing one after an Undo wipes the redo
                // stack, so a bare `i<Esc>` or a cancelled composition must
                // never reach the manager.
                if !openCommandGroupMaterialized {
                    openGroup()
                    openCommandGroupMaterialized = true
                }
            } else {
                openGroup()
            }
        }
        undoManager.registerUndo(withTarget: self) { history in
            history.restore(previous)
        }
        undoManager.setActionName(actionName)
        if !navigating, openCommandGroup == nil { closeGroup() }
    }

    func adoptExternal(_ markdown: String) {
        guard !(currentMarkdown as NSString).isEqual(to: markdown) else { return }
        undoManager.removeAllActions()
        currentMarkdown = markdown
        if !(storage.markdown as NSString).isEqual(to: markdown) {
            storage.markdown = markdown
        }
    }

    private func restore(_ markdown: String) {
        registerStep(restoring: currentMarkdown, actionName: "Edit")
        currentMarkdown = markdown
        if !(storage.markdown as NSString).isEqual(to: markdown) {
            storage.markdown = markdown
        }
        writeDocument(markdown)
    }

    // MARK: - RectoEditorHistory

    /// Vim's hook: fired when the manager's own navigation (menu Undo/Redo)
    /// closes an open command group, so the key layer ends the session
    /// coherently instead of typing on under a stale flag.
    var onExternalHistoryNavigation: (@MainActor @Sendable () -> Void)?
    /// Its pair: fired after the navigation's storage changes have landed, so
    /// the layer stops resyncing mode-preserving once the aftermath is over.
    var onExternalHistoryNavigationEnded: (@MainActor @Sendable () -> Void)?

    /// `groupsByEvent` as it was before the current explicit group opened.
    private var openGroupPreviousGroupsByEvent: Bool?
    /// Set while a vim command group spans keystrokes.
    private var openCommandGroup: Bool?
    /// Whether the open command group has seen an edit. The NSUndoManager
    /// group exists only from that first edit on (see `registerStep`).
    private var openCommandGroupMaterialized = false
    var groupOpen: Bool { openCommandGroup != nil }

    /// Event grouping is off only while an explicit group is open: left on,
    /// AppKit would close its own per-event group around ours at the end of
    /// the pass; left off for good, its IME path (`_prepareEventGrouping`)
    /// raises on the text view's undo manager.
    private func openGroup() {
        openGroupPreviousGroupsByEvent = undoManager.groupsByEvent
        undoManager.groupsByEvent = false
        undoManager.beginUndoGrouping()
    }

    private func closeGroup() {
        undoManager.endUndoGrouping()
        if let previous = openGroupPreviousGroupsByEvent {
            undoManager.groupsByEvent = previous
            openGroupPreviousGroupsByEvent = nil
        }
    }

    /// Vim's `u`/`<C-r>` and ⌘Z share this manager, so they never disagree
    /// about what the last step was. The caret comes from a diff of the two
    /// snapshots: right for every contiguous change, and the known fallback
    /// where text repeats until B4 stores a patch per node.
    func performHistory(_ direction: RectoHistoryDirection) -> RectoHistoryOutcome? {
        endCommandGroup()
        let before = currentMarkdown
        switch direction {
        case .undo:
            guard undoManager.canUndo else { return nil }
            undoManager.undo()
        case .redo:
            guard undoManager.canRedo else { return nil }
            undoManager.redo()
        }
        guard !(currentMarkdown as NSString).isEqual(to: before) else { return nil }
        return RectoHistoryOutcome(
            markdown: currentMarkdown,
            patchStart: MarkdownTextPatch.diff(from: before, to: currentMarkdown).range.location
        )
    }

    /// One group across the keystrokes of an insert session, so `iabc<Esc>u`
    /// removes `abc` and not `c`.
    func beginCommandGroup() {
        guard openCommandGroup == nil else { return }
        openCommandGroup = true
        openCommandGroupMaterialized = false
    }

    func endCommandGroup() {
        guard openCommandGroup != nil else { return }
        openCommandGroup = nil
        guard openCommandGroupMaterialized else { return }
        openCommandGroupMaterialized = false
        closeGroup()
    }
}
