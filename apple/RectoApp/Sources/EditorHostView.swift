import Foundation
import RectoEditor
import SwiftUI

struct EditorHostView: View {
    @Binding private var document: RectoDocument
    @State private var storage: RectoTextStorage
    @StateObject private var history: DocumentUndoHistory
    @State private var writingController = RectoWritingController()
    @AppStorage(PresentationPreference.key) private var storedPresentation: String?
    /// This window's lens. `nil` until it appears, when it takes the stored
    /// default; after that only the writer's own choice moves it.
    @State private var chosenPresentation: Presentation?
    private let isEditable: Bool

    init(document: Binding<RectoDocument>, isEditable: Bool) {
        self.init(
            document: document,
            isEditable: isEditable,
            storage: RectoTextStorage(
                documentId: UUID().uuidString,
                markdown: document.wrappedValue.markdown
            )
        )
    }

    init(document: Binding<RectoDocument>, isEditable: Bool = true,
         storage: RectoTextStorage) {
        _document = document
        self.isEditable = isEditable
        _storage = State(initialValue: storage)
        _history = StateObject(wrappedValue: DocumentUndoHistory(
            document: document,
            storage: storage
        ))
    }

    private var presentation: Presentation {
        PresentationPreference.presentation(
            chosen: chosenPresentation,
            stored: storedPresentation,
            isEditable: isEditable
        )
    }

    private var styler: MarkdownStyler {
        MarkdownStyler(presentation: presentation, theme: .twilight, undo: .external)
    }

    private func choose(_ presentation: Presentation) {
        chosenPresentation = presentation
        storedPresentation = presentation.rawValue
    }

    var body: some View {
        VStack(spacing: 0) {
            RectoEditorView(
                storage: storage,
                styler: styler,
                placeholder: "Start writing…",
                onEdit: history.accept,
                writingController: writingController
            )
            .frame(minWidth: 720, minHeight: 540)
            .background(WritingControlsHost(controller: writingController))
            EditorStatusBar(
                presentation: styler.presentation,
                isEditable: isEditable,
                storage: storage,
                theme: styler.theme,
                onSelect: choose
            )
        }
        .onAppear {
            if chosenPresentation == nil {
                chosenPresentation = PresentationPreference.choice(from: storedPresentation)
            }
            history.attach(authoritativeMarkdown: document.markdown)
        }
        .onDisappear {
            history.detach()
        }
        .onChange(of: ExactMarkdown(document.markdown)) { _, markdown in
            history.adoptExternal(markdown.value)
        }
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
