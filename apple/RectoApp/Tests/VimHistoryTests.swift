import RectoEditor
import SwiftUI
import Testing
@testable import Recto

/// `DocumentUndoHistory` as vim's `RectoEditorHistory`: `u` runs the same
/// manager ⌘Z does, an insert session is one step, and the outcome carries the
/// document and where the change starts.
@Suite("Vim history over the document undo manager")
@MainActor
struct VimHistoryTests {
    private final class DocumentBox {
        var value: RectoDocument
        init(_ markdown: String) { value = RectoDocument(markdown: markdown) }
    }

    private func make(_ markdown: String) -> (DocumentUndoHistory, RectoTextStorage, DocumentBox) {
        let box = DocumentBox(markdown)
        let storage = RectoTextStorage(documentId: "vim-history", markdown: markdown)
        let history = DocumentUndoHistory(
            document: Binding(get: { box.value }, set: { box.value = $0 }),
            storage: storage
        )
        history.attach(authoritativeMarkdown: markdown)
        return (history, storage, box)
    }

    @Test("undo restores the previous snapshot and reports the change start")
    func undoOutcome() {
        let (history, storage, box) = make("the quick brown fox\n")
        history.accept("the brown fox\n")

        let outcome = history.performHistory(.undo)

        #expect(outcome == RectoHistoryOutcome(markdown: "the quick brown fox\n", patchStart: 4))
        #expect(storage.markdown == "the quick brown fox\n")
        #expect(box.value.markdown == "the quick brown fox\n")
        #expect(history.performHistory(.undo) == nil, "nothing left to undo")

        let redone = history.performHistory(.redo)
        #expect(redone == RectoHistoryOutcome(markdown: "the brown fox\n", patchStart: 4))
        #expect(history.performHistory(.redo) == nil)
    }

    @Test("edits inside a command group undo as one step")
    func commandGroupIsOneStep() {
        let (history, storage, _) = make("tail\n")
        history.accept("xtail\n")
        history.beginCommandGroup()
        history.accept("xatail\n")
        history.accept("xabtail\n")
        history.accept("xabctail\n")
        history.endCommandGroup()

        #expect(history.performHistory(.undo)?.markdown == "xtail\n")
        #expect(storage.markdown == "xtail\n")
        #expect(history.performHistory(.undo)?.markdown == "tail\n")
        #expect(history.performHistory(.redo)?.markdown == "xtail\n")
        #expect(history.performHistory(.redo)?.markdown == "xabctail\n", "redo restores the whole session")
    }

    @Test("an open command group is closed before navigating")
    func openGroupIsClosedByUndo() {
        let (history, _, _) = make("tail\n")
        history.beginCommandGroup()
        history.accept("abtail\n")

        // Vim closes the group itself before asking; this guards the manager
        // against a host that forgets, which would otherwise raise.
        #expect(history.performHistory(.undo)?.markdown == "tail\n")
        #expect(history.undoManager.groupsByEvent)
        #expect(history.undoManager.groupingLevel == 0)
    }

    @Test("detach with an open group leaves the manager balanced")
    func detachClosesGroup() {
        let (history, _, _) = make("tail\n")
        history.beginCommandGroup()
        history.accept("atail\n")
        history.detach()
        #expect(history.undoManager.groupingLevel == 0)
        #expect(history.undoManager.groupsByEvent)
        #expect(!history.undoManager.canUndo)
    }
}
