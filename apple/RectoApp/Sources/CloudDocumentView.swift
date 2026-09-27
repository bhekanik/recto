import AppKit
import RectoCore
import RectoEditor
import RectoSync
import SwiftUI

struct CloudDocumentView: View {
    let localId: String
    let registry: DocumentSessionRegistry
    let api: (any RectoAPI)?
    /// The window's shared documents and pane commands; `nil` outside panes.
    let panes: PaneContext?
    private let settings: StudioSettings
    @State private var model: CloudDocumentModel?
    /// What this view edits: the model's storage, or a mirror of it when
    /// another pane already shows the document.
    @State private var storage: RectoTextStorage?
    @State private var openingError: String?
    @State private var chrome: EditorHostController
    @State private var vim = VimHostState()
    @State private var zen = ZenMode()
    @State private var wordCount = DocumentWordCount()
    @State private var lint = ProseLint()
    @State private var historyView: HistoryView?
    @State private var history: DocumentHistoryModel?
    @State private var autoVersions = AutoVersioning()
    @State private var comments = CommentsModel()
    @State private var showsComments = false
    @State private var showsSharing = false
    @State private var review: ReviewSurfaceModel?
    @State private var ai: AIController?
    @Environment(\.rectoWebOrigin) private var webOrigin
    @AppStorage(PresentationPreference.key) private var storedPresentation: String?
    /// This window's lens. `nil` until it appears, when it takes the stored
    /// default; after that only the writer's own choice moves it.
    @State private var chosenPresentation: Presentation?
    /// The text view is attached and in a window, so it can take the keyboard.
    @State private var editorOnScreen = false

    init(
        localId: String,
        registry: DocumentSessionRegistry,
        api: (any RectoAPI)? = nil,
        panes: PaneContext? = nil,
        settings: StudioSettings = .shared
    ) {
        self.localId = localId
        self.registry = registry
        self.api = api
        self.panes = panes
        self.settings = settings
        _chrome = State(initialValue: EditorHostController(settings: settings))
    }

    var body: some View {
        Group {
            if let model {
                editor(model)
            } else if let openingError {
                ContentUnavailableView(
                    "Could not open document",
                    systemImage: "exclamationmark.triangle",
                    description: Text(openingError)
                )
            } else {
                ProgressView("Opening…")
            }
        }
        .onAppear {
            if chosenPresentation == nil {
                chosenPresentation = PresentationPreference.choice(from: storedPresentation)
            }
        }
        .task(id: localId) {
            await open()
        }
        .onDisappear {
            zen.leave()
            autoVersions.stop()
            comments.stop()
            let closing = model
            let closingStorage = storage
            model = nil
            storage = nil
            if let documents = panes?.documents {
                Task { await documents.release(localId, storage: closingStorage) }
            } else {
                Task { await closing?.close() }
            }
        }
    }

    private func paneStorage(_ model: CloudDocumentModel) -> RectoTextStorage {
        storage ?? model.storage
    }

    private func styler(_ model: CloudDocumentModel) -> MarkdownStyler {
        settings.styler(presentation: PresentationPreference.presentation(
            chosen: chosenPresentation,
            stored: storedPresentation,
            isEditable: model.isEditable
        ))
    }

    private func choose(_ presentation: Presentation) {
        chosenPresentation = presentation
        if PresentationPreference.isStorable(presentation) {
            storedPresentation = presentation.rawValue
        }
    }

    private func editor(_ model: CloudDocumentModel) -> some View {
        let styler = styler(model)
        return VStack(spacing: 0) {
            DocumentBanner(model: model)
            if settings.showToolbar, !zen.hidesChrome {
                toolbar(styler)
                    .modifier(QuietChromeFade(quiet: chrome.quiet, settings: settings))
            }
            if styler.presentation == .preview, settings.previewVariant == .email {
                EmailPreviewChrome(
                    frontmatter: paneStorage(model).frontmatter, fallbackTitle: model.state.title, theme: styler.theme)
            }
            page(model, styler)
            if settings.showStatusBar, !zen.hidesChrome {
                statusBar(model, styler)
                    .modifier(QuietChromeFade(quiet: chrome.quiet, settings: settings, quietOpacity: 0.3))
            }
        }
        .modifier(ZenChrome(zen: zen, settings: settings, toolbar: toolbar(styler), statusBar: statusBar(model, styler)))
        // Under the title bar too, so the glow starts at the window's top edge.
        .background { DocumentBackdrop(theme: styler.theme, showsSheet: styler.showsSheet).ignoresSafeArea() }
        .background {
            // Synced documents only feed the day's total, as on the web, where
            // every document is synced; a local file's words are not credited.
            WordCountTracker(
                storage: paneStorage(model), count: wordCount,
                onCount: { words in WritingStatsModel.shared.noteLiveWords(words) })
        }
        .background {
            LintTracker(
                storage: paneStorage(model), settings: settings, decorations: chrome.decorations,
                result: lint, isLintable: styler.presentation != .preview)
        }
        .onDisappear { WritingStatsModel.shared.flush() }
        .preference(key: ZenPreferenceKey.self, value: zen.isOn)
        .onAppear { wire(model) }
        .background {
            CommentHighlightTracker(storage: paneStorage(model), comments: comments, decorations: chrome.decorations)
        }
        .sheet(isPresented: Binding(get: { ai?.sheet != nil }, set: { if !$0 { ai?.sheet = nil } })) {
            if let ai { AISheetView(ai: ai, settings: settings) }
        }
        .alert(ai?.message?.title ?? "", isPresented: Binding(
            get: { ai?.message != nil }, set: { if !$0 { ai?.message = nil } }
        )) {
            if ai?.message?.opensReview == true {
                Button("Open review") { chrome.review?.openReview(); showsComments = true }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(ai?.message?.body ?? "")
        }
        .alert("AI", isPresented: Binding(
            get: { ai?.errorMessage != nil }, set: { if !$0 { ai?.errorMessage = nil } }
        )) {} message: {
            Text(ai?.errorMessage ?? "")
        }
        .sheet(isPresented: $showsSharing) {
            ShareSheet(title: model.state.title, cloud: chrome.cloud, dismiss: { showsSharing = false })
        }
        .sheet(isPresented: Binding(get: { review != nil }, set: { if !$0 { review?.stop(); review = nil } })) {
            if let review {
                ReviewSurface(review: review, settings: settings, theme: styler.theme, dismiss: {
                    review.stop()
                    self.review = nil
                })
            }
        }
        .modifier(DocumentChanges(model: model, react: { react($0, model) }, panesActive: panes?.isActive, historyView: historyView))
        .onChange(of: settings.spellcheck) { chrome.applySettings() }
        .onChange(of: settings.focusDim) { chrome.applySettings() }
        .onChange(of: settings.focusDimScope) { chrome.applySettings() }
        .onChange(of: settings.theme) { chrome.applySettings() }
        .onChange(of: settings.typewriter) { chrome.applySettings() }
        .onChange(of: settings.focusBlur) { chrome.applySettings() }
        .onChange(of: styler.presentation) { _, presentation in
            vim.sync(seam: paneStorage(model).textView, presentation: presentation)
            chrome.applySettings()
        }
        .modifier(DocumentNavigationTitle(model: model))
        .onChange(of: KeyboardHandoff(wanted: panes?.wantsKeyboard == true, ready: editorOnScreen), initial: true) {
            takeKeyboardIfWanted()
        }
        // No window-toolbar undo/redo: TopFormatToolbar owns the buttons (web
        // parity) and the Edit menu owns the chords, dispatched through
        // EditorHostRegistry so ⌘Z still undoes in this window.
    }


    private struct KeyboardHandoff: Equatable {
        let wanted: Bool
        let ready: Bool
    }

    /// The pane asked for the keyboard (the app opening, a new document,
    /// Return in the list, Go to editor): give it to the text once it is on
    /// screen, and tell the pane so the next document mounting there does not
    /// take it again.
    private func takeKeyboardIfWanted() {
        guard let panes, panes.wantsKeyboard, editorOnScreen else { return }
        chrome.focusTextWhenOnScreen(then: panes.tookKeyboard)
    }

    /// Hook the window's chrome up to this document.
    private func wire(_ model: CloudDocumentModel) {
        chrome.undo = { [model] in Task { await model.undo() } }
        chrome.redo = { [model] in Task { await model.redo() } }
        chrome.choosePresentation = choose
        chrome.currentPresentation = { [model] in self.styler(model).presentation }
        chrome.zen = zen
        chrome.panes = panes?.commands
        chrome.openHistory = { view in historyView = historyView == view ? nil : view }
        chrome.checkpoint = { [model] in checkpoint(model) }
        chrome.onFocus = panes?.activate ?? {}
        chrome.cloud = cloudContext(model, convexId: model.state.convexId)
        comments.follow(chrome.cloud)
        chrome.decorations.onOpenComment = { id in
            showsComments = true
            comments.focusedId = id
        }
        let controller = AIController(settings: settings, chrome: chrome, model: model, storage: { paneStorage(model) })
        ai = controller
        chrome.ai = AIHooks(
            toggle: controller.toggle, transform: controller.beginTransform,
            critique: controller.critique, related: controller.findRelated, reindex: controller.reindex)
        chrome.review = ReviewHooks(
            openSharing: { showsSharing = true },
            openReview: {
                let surface = ReviewSurfaceModel()
                surface.follow(chrome.cloud)
                review = surface
            },
            toggleComments: { showsComments.toggle() },
            addComment: { [model] in
                let storage = paneStorage(model)
                comments.startDraft(markdown: storage.markdown, selection: chrome.seam?.selectedRange ?? NSRange())
                if comments.draft != nil { showsComments = true }
            })
        chrome.documentTitle = model.state.title
        vim.controller.history = model
        vim.controller.onSave = { Task { await model.save() } }
    }

    private func cloudContext(_ model: CloudDocumentModel, convexId: String?) -> CloudDocumentContext? {
        api.map { CloudDocumentContext(api: $0, convexId: convexId, syncForExport: { await model.syncForExport() }) }
    }

    private func react(_ change: DocumentChanges.Change, _ model: CloudDocumentModel) {
        switch change {
        case .convexId(let convexId):
            chrome.cloud = cloudContext(model, convexId: convexId)
            history?.followVersions(chrome.cloud)
            comments.follow(chrome.cloud)
        case .title(let title):
            chrome.documentTitle = title
        case .head:
            if let history { Task { await history.reloadNodes() } }
            autoVersions.headMoved(
                to: model.state.head, isSynced: { [model] in model.state.syncState == .synced }, cloud: chrome.cloud)
        case .historyView(let view):
            if view == nil {
                history?.stop()
                history = nil
            } else if history == nil {
                let opened = DocumentHistoryModel(document: model)
                history = opened
                opened.followVersions(chrome.cloud)
                Task { await opened.reloadNodes() }
            }
        case .opened:
            if let offset = panes?.pendingJump {
                // A citation: land on it once the text is on screen.
                DispatchQueue.main.async { chrome.jump(to: NSRange(location: offset, length: 0)) }
                panes?.clearJump()
            }
        case .activated:
            // Moved here by a command, not a click: give it the keyboard.
            if let textView = chrome.seam?.nsTextView, textView.window?.firstResponder !== textView {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    /// The text, and the outline beside it when shown.
    private func page(_ model: CloudDocumentModel, _ styler: MarkdownStyler) -> some View {
        HStack(spacing: 0) {
            RectoEditorView(
                storage: paneStorage(model),
                styler: styler,
                placeholder: "Start writing…   ⌘K for commands",
                onAttach: { seam in
                    chrome.attach(seam)
                    vim.sync(seam: seam, presentation: styler.presentation)
                    editorOnScreen = seam != nil
                },
                onEdit: { [storage = paneStorage(model)] edit in model.accept(edit, from: storage) },
                writingController: chrome.writingController
            )
            // Panes share the window, so each may be narrower than a window's page.
            .frame(minWidth: panes == nil ? 620 : 280, minHeight: panes == nil ? 500 : 200)
            .background(WritingControlsHost(controller: chrome.writingController))
            if let ai, ai.showsRelated, !zen.hidesChrome {
                RelatedPanel(ai: ai, theme: styler.theme) { passage in
                    panes?.openDocument(passage.documentId, Int(passage.charStart))
                }
            }
            if showsComments, !zen.hidesChrome {
                CommentsPanel(
                    comments: comments, theme: styler.theme,
                    jump: { [chrome] range in chrome.jump(to: range) },
                    close: { showsComments = false })
            }
            if chrome.notes.isVisible(settings), !zen.hidesChrome {
                notesPanel(storage: paneStorage(model), theme: styler.theme)
            }
            if let history, historyView != nil, !zen.hidesChrome {
                HistoryPanel(history: history, settings: settings, theme: styler.theme, view: $historyView)
            }
            if settings.showOutline, !zen.hidesChrome {
                OutlinePanel(
                    storage: paneStorage(model),
                    theme: styler.theme,
                    jump: { [chrome] heading in chrome.jump(toHeading: heading) },
                    close: { [settings] in settings.toggleOutline() }
                )
            }
        }
    }

    private func notesPanel(storage: RectoTextStorage, theme: RectoEditorTheme) -> some View {
        NotesPanel(
            storage: storage, theme: theme, settings: settings,
            goTo: { [chrome] flag in chrome.goTo(flag) },
            resolve: { [chrome] flag in chrome.resolve(flag) },
            close: { [chrome, settings] in
                chrome.notes.setOpen(false, settings)
                chrome.focusText()
            })
    }

    private func toolbar(_ styler: MarkdownStyler) -> some View {
        TopFormatToolbar(
            theme: styler.theme,
            presentation: styler.presentation,
            actions: chrome.formatToolbarActions
        )
    }

    private func statusBar(_ model: CloudDocumentModel, _ styler: MarkdownStyler) -> some View {
        EditorStatusBar(
            presentation: styler.presentation,
            isEditable: model.isEditable,
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
        ) {
            DocumentCloudStatus(model: model, webOrigin: webOrigin, theme: styler.theme, openInWeb: openInWeb)
        }
    }

    private func open() async {
        if let documents = panes?.documents {
            await openShared(documents)
            return
        }
        await model?.close()
        model = nil
        openingError = nil
        do {
            let opened = try await CloudDocumentModel.open(
                localId: localId,
                registry: registry,
                waitForEditableHolder: true
            )
            if Task.isCancelled {
                await opened.close()
                return
            }
            model = opened
        } catch is CancellationError {
        } catch {
            openingError = error.localizedDescription
        }
    }

    /// Through the window's shared documents, so a second pane on this
    /// document mirrors the first instead of queuing behind it.
    private func openShared(_ documents: PaneDocuments) async {
        if let model {
            await documents.release(model.localId, storage: storage)
            self.model = nil
            storage = nil
        }
        openingError = nil
        do {
            let (opened, paneStorage) = try await documents.acquire(localId, registry: registry)
            if Task.isCancelled {
                await documents.release(localId, storage: paneStorage)
                return
            }
            storage = paneStorage
            model = opened
        } catch is CancellationError {
        } catch {
            openingError = error.localizedDescription
        }
    }

    /// The web's `handleCheckpoint`: name it, then tag the current node.
    private func checkpoint(_ model: CloudDocumentModel) {
        guard let label = TextPrompt.ask(
            "Name this version", defaultValue: "Checkpoint \(Date().formatted(date: .abbreviated, time: .shortened))")
        else { return }
        let tagger = history ?? DocumentHistoryModel(document: model)
        tagger.followVersions(chrome.cloud)
        Task {
            if !(await tagger.tagCurrent(label: label.isEmpty ? "Checkpoint" : label)), let message = tagger.errorMessage {
                ExportController.presentError("Couldn't create the version.", RemoteCallError(code: nil, message: message), window: chrome.window)
            }
            if tagger !== history { tagger.stop() }
        }
    }

    private func openInWeb(convexId: String?) {
        guard let origin = webOrigin, let convexId,
              let url = DocumentLink.webURL(origin: origin, convexId: convexId)
        else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct OpenInWebButton: View {
    let enabled: Bool
    let help: String
    let theme: RectoEditorTheme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "globe")
                .font(.system(size: 12))
                .frame(width: 24, height: 24)
                .foregroundStyle(Color(nsColor: theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel("Open in web app")
    }
}

/// The document changes a synced host reacts to, as one modifier so the host's
/// body stays within what the type checker will take.
private struct DocumentChanges: ViewModifier {
    enum Change {
        case convexId(String?)
        case title(String)
        case head
        case historyView(HistoryView?)
        case activated
        case opened
    }

    let model: CloudDocumentModel
    let react: (Change) -> Void
    let panesActive: Bool?
    let historyView: HistoryView?

    func body(content: Content) -> some View {
        content
            .onChange(of: model.state.convexId) { _, id in react(.convexId(id)) }
            .onChange(of: model.state.title) { _, title in react(.title(title)) }
            .onChange(of: model.state.head) { react(.head) }
            .onChange(of: historyView) { _, view in react(.historyView(view)) }
            .onChange(of: panesActive) { _, active in if active == true { react(.activated) } }
            .onAppear { react(.opened) }
    }
}

/// The document's sync and edit problems, above the page. Its own view so the
/// state it reads, which the session replaces after every commit, re-renders
/// this strip and not the whole document view.
private struct DocumentBanner: View {
    let model: CloudDocumentModel

    var body: some View {
        if model.state.syncState == .diverged {
            divergenceBanner(model)
        } else if let error = model.editError {
            statusBanner(error, color: .red)
        } else if model.state.syncState == .failed {
            statusBanner("Sync failed. Your changes remain on this Mac.", color: .orange)
        }
    }

    private func divergenceBanner(_ model: CloudDocumentModel) -> some View {
        HStack {
            Text("This document changed on another device. Both versions are safe.")
            Spacer()
            Button("Keep this Mac's version") {
                Task { await model.keepLocalBranch() }
            }
            Button("Use remote version") {
                Task { await model.keepRemoteBranch() }
            }
        }
        .padding(10)
        .background(.orange.opacity(0.18))
    }

    private func statusBanner(_ message: String, color: Color) -> some View {
        Text(message)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(color.opacity(0.16))
            .textSelection(.enabled)
    }
}

/// The status bar's web and sync slots, scoped like ``DocumentBanner``.
private struct DocumentCloudStatus: View {
    let model: CloudDocumentModel
    let webOrigin: URL?
    let theme: RectoEditorTheme
    let openInWeb: (String?) -> Void

    var body: some View {
        HStack(spacing: 8) {
            OpenInWebButton(
                enabled: WebHandoff.isEnabled(convexId: model.state.convexId, webOrigin: webOrigin),
                help: WebHandoff.disabledReason(convexId: model.state.convexId, webOrigin: webOrigin),
                theme: theme
            ) {
                openInWeb(model.state.convexId)
            }
            SyncIndicator(
                state: isSaving && !savingIsSlow ? .synced : model.state.syncState,
                pendingCount: savingIsSlow ? pendingCount : 0,
                theme: theme
            )
        }
        .onReceive(model.pendingEditCounts) { pendingCount = $0 }
        .task(id: isSaving) {
            savingIsSlow = false
            guard isSaving else { return }
            try? await Task.sleep(for: Self.savingDelay)
            if !Task.isCancelled { savingIsSlow = true }
        }
    }

    /// Every keystroke saves and syncs within a moment, so an honest label
    /// flips Saving ↔ Saved several times a second while the writer types.
    /// "Saving" shows only once a save has taken this long; failures and
    /// divergence still show at once.
    static let savingDelay: Duration = .seconds(1)

    @State private var savingIsSlow = false
    @State private var pendingCount = 0

    private var isSaving: Bool {
        guard pendingCount == 0 else { return true }
        switch model.state.syncState {
        case .pending, .syncing: return true
        case .synced, .failed, .diverged: return false
        }
    }
}

/// The window title, scoped like ``DocumentBanner``.
private struct DocumentNavigationTitle: ViewModifier {
    let model: CloudDocumentModel

    func body(content: Content) -> some View {
        content.navigationTitle(model.state.title)
    }
}
