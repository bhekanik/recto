import AppKit
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

@Suite("Document editor", .serialized)
@MainActor
struct EditorHostViewTests {
    // Closing this window can deallocate AppKit's transform animation during
    // the next test's CA commit, crashing the test process before assertions run.
    private static var retainedEditorInputWindow: NSWindow?

    private final class DocumentBox {
        var value: RectoDocument

        init(_ markdown: String) {
            value = RectoDocument(markdown: markdown)
        }
    }

    @Observable
    @MainActor
    final class ReplacementModel {
        var storage: RectoTextStorage
        var identity = 0
        var documentMarkdown: String

        init(storage: RectoTextStorage) {
            self.storage = storage
            documentMarkdown = storage.markdown
        }
    }

    private struct ReplacementHost: View {
        let model: ReplacementModel

        var body: some View {
            RectoEditorView(
                storage: model.storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                onTextChange: { model.documentMarkdown = $0 }
            )
            .id(model.identity)
        }
    }

    private func mount(_ markdown: String, id: String)
        -> (DocumentBox, RectoTextStorage, NSHostingView<EditorHostView>, NSWindow) {
        let document = DocumentBox(markdown)
        let storage = RectoTextStorage(documentId: id, markdown: markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(
                get: { document.value },
                set: { document.value = $0 }
            ),
            storage: storage
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        return (document, storage, host, window)
    }

    @Test("native Return keeps CRLF and dirties the document before teardown")
    func nativeReturnKeepsCRLFBeforeTeardown() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("a\r\nb", id: "crlf-return")
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 1, length: 0))
        textView.insertNewline(nil)

        #expect(textView.string == "a\r\n\r\nb")
        window.close()
        #expect(document.value.markdown == "a\r\n\r\nb")
    }

    @Test("CRLF Return is one exact undo and redo action")
    func crlfReturnUndoRedo() async throws {
        _ = NSApplication.shared
        let original = "a\r\nb"
        let edited = "a\r\n\r\nb"
        let (document, storage, host, window) = mount(original, id: "crlf-return-undo")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 1, length: 0))

        textView.insertNewline(nil)
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(undoManager.levelsOfUndo == 100)
        #expect(!textView.allowsUndo)
        #expect(textView.delegate?.undoManager?(for: textView) === undoManager)
        #expect(undoManager.canUndo)
        #expect(undoManager.undoActionName == "Edit")
        #expect(textView.string == edited)
        #expect(document.value.markdown == edited)

        undoManager.undo()

        #expect(textView.string == original)
        #expect(document.value.markdown == original)
        #expect(!undoManager.canUndo)
        #expect(undoManager.canRedo)
        #expect(undoManager.redoActionName == "Edit")

        undoManager.redo()

        #expect(textView.string == edited)
        #expect(document.value.markdown == edited)
        #expect(!undoManager.canRedo)
    }

    @Test("typing undo and redo update the document binding synchronously")
    func typingUndoRedoUpdatesDocumentSynchronously() async throws {
        _ = NSApplication.shared
        let original = "body"
        let edited = "body!"
        let (document, storage, host, window) = mount(original, id: "typing-undo")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))

        textView.insertText("!", replacementRange: NSRange(location: 4, length: 0))
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(undoManager.canUndo)
        #expect(document.value.markdown == edited)

        undoManager.undo()

        #expect(textView.string == original)
        #expect(storage.markdown == original)
        #expect(document.value.markdown == original)
        #expect(undoManager.canRedo)

        undoManager.redo()

        #expect(textView.string == edited)
        #expect(storage.markdown == edited)
        #expect(document.value.markdown == edited)
    }

    @Test("an external document replacement clears stale edit history")
    func externalReplacementClearsHistory() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("body", id: "external-history")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))

        textView.insertText("!", replacementRange: NSRange(location: 4, length: 0))
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(undoManager.canUndo)

        document.value.markdown = "external\r\n"
        host.rootView = EditorHostView(
            document: Binding(
                get: { document.value },
                set: { document.value = $0 }
            ),
            storage: storage
        )
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(textView.string == "external\r\n")
        #expect(storage.markdown == "external\r\n")
        #expect(document.value.markdown == "external\r\n")
        #expect(!undoManager.canUndo)
        #expect(!undoManager.canRedo)
    }

    @Test("normalized mixed-ending paste has exact undo and redo")
    func normalizedPasteUndoRedo() async throws {
        _ = NSApplication.shared
        let original = "start\r\n"
        let edited = "start\r\none\r\ntwo\r\nthree"
        let (document, storage, host, window) = mount(original, id: "paste-undo")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 7, length: 0))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("one\ntwo\r\nthree", forType: .string)

        textView.paste(nil)
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(textView.string == edited)
        #expect(document.value.markdown == edited)
        #expect(undoManager.canUndo)

        undoManager.undo()

        #expect(textView.string == original)
        #expect(document.value.markdown == original)
        #expect(undoManager.canRedo)

        undoManager.redo()

        #expect(textView.string == edited)
        #expect(document.value.markdown == edited)
    }

    @Test("BOM bytes and an adjacent emoji range survive undo and redo")
    func bomEmojiUndoRedo() async throws {
        _ = NSApplication.shared
        let bom = Data([0xEF, 0xBB, 0xBF])
        let original = "A🧑🏽‍💻B\r\n"
        let edited = "A🧑🏽‍💻✅\r\n"
        var document = try RectoDocument(fileContents: bom + Data(original.utf8))
        let storage = RectoTextStorage(documentId: "bom-emoji-undo", markdown: document.markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document }, set: { document = $0 }),
            storage: storage
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        let replacementRange = (original as NSString).range(of: "B")

        textView.insertText("✅", replacementRange: replacementRange)
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(textView.string == edited)
        #expect(document.encodedData == bom + Data(edited.utf8))

        undoManager.undo()

        #expect(textView.string == original)
        #expect(document.encodedData == bom + Data(original.utf8))

        undoManager.redo()

        #expect(textView.string == edited)
        #expect(document.encodedData == bom + Data(edited.utf8))
    }

    @Test("accepted typing dirties the document before immediate teardown")
    func typingSurvivesImmediateTeardown() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("body", id: "teardown")
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.insertText("!", replacementRange: NSRange(location: 4, length: 0))
        window.close()

        #expect(document.value.markdown == "body!")
    }

    @Test("native editing preserves Unicode and the UTF-8 byte-order mark")
    func nativeEditingPreservesUnicodeAndBOM() async throws {
        _ = NSApplication.shared
        let bom = Data([0xEF, 0xBB, 0xBF])
        let source = "# Café 世界\r\n"
        var document = try RectoDocument(fileContents: bom + Data(source.utf8))
        let storage = RectoTextStorage(documentId: "bom", markdown: document.markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document }, set: { document = $0 }),
            storage: storage
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: (source as NSString).length, length: 0))

        textView.insertText("Edited ✅\n", replacementRange: textView.selectedRange())

        let expected = bom + Data((source + "Edited ✅\r\n").utf8)
        #expect(textView.string == source + "Edited ✅\r\n")
        window.close()
        #expect(document.encodedData == expected)
    }

    @Test("native Return keeps LF in LF, empty, and no-final-newline documents", arguments: [
        ("a\nb", 1, "a\n\nb"),
        ("", 0, "\n"),
        ("tail", 4, "tail\n"),
    ])
    func nativeReturnKeepsLF(source: String, caret: Int, expected: String) async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount(source, id: "lf-return-\(caret)")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: caret, length: 0))

        textView.insertNewline(nil)

        #expect(textView.string == expected)
        #expect(document.value.markdown == expected)
    }

    @Test("smart-list Return uses the CRLF convention before teardown")
    func smartListReturnKeepsCRLF() async throws {
        _ = NSApplication.shared
        let source = "- item\r\nnext"
        let expected = "- item\r\n- \r\nnext"
        let (document, storage, host, window) = mount(source, id: "smart-list-crlf")
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 6, length: 0))

        textView.insertNewline(nil)

        #expect(textView.string == expected)
        window.close()
        #expect(document.value.markdown == expected)
    }

    @Test("paste normalizes foreign newlines before teardown")
    func pasteNormalizesForeignNewlines() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("start\r\n", id: "paste-crlf")
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 7, length: 0))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("one\ntwo\r\nthree", forType: .string)

        textView.paste(nil)

        let expected = "start\r\none\r\ntwo\r\nthree"
        #expect(textView.string == expected)
        window.close()
        #expect(document.value.markdown == expected)
    }

    @Test("native deletion and replacement keep CRLF boundaries intact")
    func editsAtCRLFBoundary() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("a\r\nb", id: "boundary-crlf")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)

        textView.insertText("x\n", replacementRange: NSRange(location: 1, length: 2))
        #expect(textView.string == "ax\r\nb")
        #expect(document.value.markdown == "ax\r\nb")

        textView.insertText("", replacementRange: NSRange(location: 2, length: 2))
        #expect(textView.string == "axb")
        #expect(document.value.markdown == "axb")
    }

    @Test("IME composition becomes authoritative only when committed")
    func compositionCommitIsAuthoritative() async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount("body", id: "ime")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 4, length: 0))

        textView.setMarkedText(
            "に",
            selectedRange: NSRange(location: 1, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0)
        )
        #expect(textView.hasMarkedText())
        #expect(document.value.markdown == "body")

        textView.insertText("日本", replacementRange: textView.markedRange())

        #expect(!textView.hasMarkedText())
        #expect(textView.string == "body日本")
        #expect(document.value.markdown == "body日本")
    }

    @Test("a dismantled editor cannot write into its replacement document")
    func dismantledEditorCannotWriteReplacement() async throws {
        _ = NSApplication.shared
        let first = RectoTextStorage(documentId: "old", markdown: "old")
        let replacement = RectoTextStorage(documentId: "new", markdown: "new")
        let model = ReplacementModel(storage: first)
        let host = NSHostingView(rootView: ReplacementHost(model: model))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let oldTextView = try #require(first.textView.nsTextView)

        model.storage = replacement
        model.documentMarkdown = replacement.markdown
        model.identity += 1
        await drainMainQueue()
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let replacementTextView = try #require(replacement.textView.nsTextView)
        #expect(replacementTextView !== oldTextView)

        oldTextView.insertText("!", replacementRange: NSRange(location: 3, length: 0))

        #expect(first.markdown == "old")
        #expect(replacement.markdown == "new")
        #expect(model.documentMarkdown == "new")
    }

    @Test("accepted editor input updates the file document binding")
    func editorInputUpdatesDocument() async throws {
        _ = NSApplication.shared
        let original = "# Hello, 世界\r\n\r\n[link](https://example.com) and `code`\r\n"
        var document = RectoDocument(markdown: original)
        let storage = RectoTextStorage(documentId: "binding-test", markdown: document.markdown)
        var storageSnapshotsAtDocumentWrite: [String] = []
        let binding = Binding(
            get: { document },
            set: {
                storageSnapshotsAtDocumentWrite.append(storage.markdown)
                document = $0
            }
        )
        let host = NSHostingView(rootView: EditorHostView(document: binding, storage: storage))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { Self.retainedEditorInputWindow = window }

        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: (storage.markdown as NSString).length, length: 0))
        textView.insertText("Edited ✅\r\n", replacementRange: textView.selectedRange())
        await drainMainQueue()

        #expect(storage.markdown == original + "Edited ✅\r\n")
        #expect(document.markdown == storage.markdown)
        #expect(storageSnapshotsAtDocumentWrite == [storage.markdown])
    }

    @Test("read-only document configurations mount a non-editable editor")
    func readOnlyDocumentIsNotEditable() async throws {
        _ = NSApplication.shared
        var document = RectoDocument(markdown: "# Read only\n")
        let storage = RectoTextStorage(documentId: "read-only-test", markdown: document.markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document }, set: { document = $0 }),
            isEditable: false,
            storage: storage
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(try #require(storage.textView.nsTextView).isEditable == false)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
