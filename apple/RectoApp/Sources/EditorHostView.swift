import Foundation
import RectoEditor
import SwiftUI

struct EditorHostView: View {
    @Binding private var document: RectoDocument
    @State private var storage: RectoTextStorage
    @StateObject private var history: DocumentUndoHistory
    @State private var chrome: EditorHostController
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
        storedPresentation = presentation.rawValue
    }

    var body: some View {
        let styler = settings.styler(presentation: presentation)
        VStack(spacing: 0) {
            if settings.showToolbar {
                TopFormatToolbar(
                    theme: styler.theme,
                    presentation: styler.presentation,
                    actions: chrome.formatToolbarActions
                )
            }
            RectoEditorView(
                storage: storage,
                styler: styler,
                placeholder: "Start writing…",
                onAttach: chrome.attach,
                onEdit: history.accept,
                writingController: chrome.writingController
            )
            .frame(minWidth: 720, minHeight: 540)
            .background(WritingControlsHost(controller: chrome.writingController))
            if settings.showStatusBar {
                EditorStatusBar(
                    presentation: styler.presentation,
                    isEditable: isEditable,
                    storage: storage,
                    settings: settings,
                    theme: styler.theme,
                    onSelect: choose
                )
            }
        }
        .onAppear {
            if chosenPresentation == nil {
                chosenPresentation = PresentationPreference.choice(from: storedPresentation)
            }
            history.attach(authoritativeMarkdown: document.markdown)
            chrome.undo = { [history] in history.undoManager.undo() }
            chrome.redo = { [history] in history.undoManager.redo() }
            chrome.choosePresentation = choose
        }
        .onDisappear {
            history.detach()
        }
        .onChange(of: ExactMarkdown(document.markdown)) { _, markdown in
            history.adoptExternal(markdown.value)
        }
        .onChange(of: settings.spellcheck) { chrome.applySettings() }
        .onChange(of: settings.typewriter) { chrome.applySettings() }
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

@MainActor
private final class DocumentUndoHistory: ObservableObject {
    // Bound V1's full-string snapshots until model history replaces this owner.
    private static let snapshotLimit = 100

    let undoManager = UndoManager()

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
    }

    func attach(authoritativeMarkdown: String) {
        adoptExternal(authoritativeMarkdown)
        storage.controller.undoManager = undoManager
    }

    func detach() {
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
        let previous = currentMarkdown
        undoManager.registerUndo(withTarget: self) { history in
            history.restore(previous)
        }
        undoManager.setActionName(edit.structural ? "Format" : "Edit")
        currentMarkdown = markdown
        writeDocument(markdown)
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
        let previous = currentMarkdown
        undoManager.registerUndo(withTarget: self) { history in
            history.restore(previous)
        }
        undoManager.setActionName("Edit")
        currentMarkdown = markdown
        if !(storage.markdown as NSString).isEqual(to: markdown) {
            storage.markdown = markdown
        }
        writeDocument(markdown)
    }
}
