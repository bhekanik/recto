import Foundation
import RectoEditor
import SwiftUI

struct EditorHostView: View {
    @Binding private var document: RectoDocument
    @State private var storage: RectoTextStorage
    @StateObject private var history: DocumentUndoHistory
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

    var body: some View {
        RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(
                presentation: isEditable ? .rich : .preview,
                theme: .twilight,
                undo: .external
            ),
            placeholder: "Start writing…",
            onTextChange: { markdown in
                history.accept(markdown)
            }
        )
        .frame(minWidth: 720, minHeight: 540)
        .onAppear {
            history.attach(authoritativeMarkdown: document.markdown)
        }
        .onDisappear {
            history.detach()
        }
        .onChange(of: document.markdown) { _, markdown in
            history.adoptExternal(markdown)
        }
    }
}

@MainActor
private final class DocumentUndoHistory: ObservableObject {
    let undoManager = UndoManager()

    private let storage: RectoTextStorage
    private let writeDocument: (String) -> Void
    private var currentMarkdown: String

    init(document: Binding<RectoDocument>, storage: RectoTextStorage) {
        self.storage = storage
        currentMarkdown = document.wrappedValue.markdown
        writeDocument = { markdown in
            guard document.wrappedValue.markdown != markdown else { return }
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
        guard markdown != currentMarkdown else { return }
        let previous = currentMarkdown
        undoManager.registerUndo(withTarget: self) { history in
            history.restore(previous)
        }
        undoManager.setActionName("Edit")
        currentMarkdown = markdown
        writeDocument(markdown)
    }

    func adoptExternal(_ markdown: String) {
        guard markdown != currentMarkdown else { return }
        undoManager.removeAllActions()
        currentMarkdown = markdown
        if storage.markdown != markdown {
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
        if storage.markdown != markdown {
            storage.markdown = markdown
        }
        writeDocument(markdown)
    }
}
