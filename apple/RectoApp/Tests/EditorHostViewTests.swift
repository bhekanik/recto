import AppKit
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

@Suite("Document editor", .serialized)
@MainActor
struct EditorHostViewTests {
    // Closing these windows can deallocate AppKit's transform animation during
    // the next test's CA commit, crashing the test process before assertions run.
    private static var retainedTransformWindows: [NSWindow] = []

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

    @Observable
    @MainActor
    final class ExternalDocumentModel {
        var document: RectoDocument

        init(markdown: String) {
            document = RectoDocument(markdown: markdown)
        }
    }

    private struct ExternalDocumentHost: View {
        @Bindable var model: ExternalDocumentModel
        let storage: RectoTextStorage

        var body: some View {
            EditorHostView(document: $model.document, storage: storage)
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
        defer { Self.retainedTransformWindows.append(window) }

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

    @Test(
        "canonical Unicode editor input reaches the binding and undo history",
        arguments: [
            ("😀 café\r\nsecond\n", "😀 cafe\u{301}\r\nsecond\n", "café", "cafe\u{301}"),
            ("😀 cafe\u{301}\r\nsecond\n", "😀 café\r\nsecond\n", "cafe\u{301}", "café"),
        ]
    )
    func canonicalUnicodeEditorInputReachesBinding(
        original: String,
        edited: String,
        originalWord: String,
        editedWord: String
    ) async throws {
        _ = NSApplication.shared
        let (document, storage, host, window) = mount(original, id: "canonical-binding")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))

        textView.insertText(
            editedWord,
            replacementRange: (original as NSString).range(of: originalWord)
        )
        await drainMainQueue()

        let undoManager = try #require(storage.controller.undoManager)
        #expect(Array(textView.string.utf16) == Array(edited.utf16))
        #expect(Array(storage.markdown.utf16) == Array(edited.utf16))
        #expect(Array(document.value.markdown.utf16) == Array(edited.utf16))
        #expect(undoManager.canUndo)

        undoManager.undo()
        #expect(Array(textView.string.utf16) == Array(original.utf16))
        #expect(Array(storage.markdown.utf16) == Array(original.utf16))
        #expect(Array(document.value.markdown.utf16) == Array(original.utf16))
        #expect(undoManager.canRedo)

        undoManager.redo()
        #expect(Array(textView.string.utf16) == Array(edited.utf16))
        #expect(Array(storage.markdown.utf16) == Array(edited.utf16))
        #expect(Array(document.value.markdown.utf16) == Array(edited.utf16))
    }

    @Test(
        "canonical Unicode external replacement reaches mounted editor storage",
        arguments: [
            ("😀 café\r\nsecond\n", "😀 cafe\u{301}\r\nsecond\n"),
            ("😀 cafe\u{301}\r\nsecond\n", "😀 café\r\nsecond\n"),
        ]
    )
    func canonicalUnicodeExternalReplacement(original: String, replacement: String) async throws {
        _ = NSApplication.shared
        let model = ExternalDocumentModel(markdown: original)
        let storage = RectoTextStorage(documentId: "canonical-external", markdown: original)
        let host = NSHostingView(rootView: ExternalDocumentHost(model: model, storage: storage))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)

        model.document.markdown = replacement
        await drainMainQueue()

        #expect(Array(textView.string.utf16) == Array(replacement.utf16))
        #expect(Array(storage.markdown.utf16) == Array(replacement.utf16))
        let undoManager = try #require(storage.controller.undoManager)
        #expect(!undoManager.canUndo)
        #expect(!undoManager.canRedo)
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

    @Test("selection chrome follows its owning window lifecycle")
    func selectionChromeWindowLifecycle() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "selection-window", markdown: "Select me")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 0, length: 6))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        coordinator.refresh()

        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        #expect(coordinator.isSelectionPanelVisible)
        #expect(coordinator.selectionPanelParent === window)

        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        await drainMainQueue()
        #expect(!coordinator.isSelectionPanelVisible)

        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        #expect(coordinator.isSelectionPanelVisible)

        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: window)
        #expect(!coordinator.isSelectionPanelVisible)

        coordinator.uninstall()
        #expect(coordinator.selectionPanelParent == nil)
        #expect((window.childWindows ?? []).isEmpty)
    }

    @Test("stale coordinator teardown preserves replacement callbacks")
    func staleCoordinatorTeardownPreservesReplacementCallbacks() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "selection-replacement", markdown: "Select me")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 6))

        let staleCoordinator = WritingControlsHost.Coordinator(controller: controller)
        staleCoordinator.install()
        let replacementCoordinator = WritingControlsHost.Coordinator(controller: controller)
        replacementCoordinator.install()
        defer {
            replacementCoordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }

        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        #expect(replacementCoordinator.isSelectionPanelVisible)

        staleCoordinator.uninstall()
        #expect(controller.onStateChange != nil)
        #expect(controller.onActivateSlashEntry != nil)
        controller.onStateChange?()
        #expect(replacementCoordinator.isSelectionPanelVisible)
    }

    @Test("selection chrome follows scrolling and owner window geometry")
    func selectionChromeGeometryLifecycle() async throws {
        _ = NSApplication.shared
        let lines = (0..<60).map { "line \($0) target" }.joined(separator: "\n")
        let storage = RectoTextStorage(documentId: "selection-geometry", markdown: lines)
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 160, width: 620, height: 320),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        let selection = (lines as NSString).range(of: "line 3 target")
        textView.setSelectedRange(selection)

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        coordinator.refresh()
        let initialFrame = try #require(coordinator.selectionPanelFrame)
        expectSelectionPanelPosition(coordinator, controller: controller)

        window.setFrameOrigin(NSPoint(x: window.frame.origin.x + 70, y: window.frame.origin.y + 45))
        #expect(await waitUntil {
            selectionPanelMatchesPosition(coordinator, controller: controller)
        })
        let movedFrame = try #require(coordinator.selectionPanelFrame)
        #expect(movedFrame != initialFrame)

        for index in 0..<20 {
            window.setContentSize(NSSize(width: 440 + index % 2, height: 260 + index % 3))
            #expect(selectionPanelMatchesPosition(coordinator, controller: controller))
        }
        #expect(coordinator.isSelectionPanelVisible)

        let clipView = try #require(textView.enclosingScrollView?.contentView)
        let frameBeforeScroll = try #require(coordinator.selectionPanelFrame)
        clipView.scroll(to: NSPoint(x: clipView.bounds.origin.x, y: clipView.bounds.origin.y + 12))
        textView.enclosingScrollView?.reflectScrolledClipView(clipView)
        #expect(await waitUntil {
            guard let frameAfterScroll = coordinator.selectionPanelFrame else { return false }
            return abs(frameAfterScroll.origin.y - frameBeforeScroll.origin.y) > 1
        })

        clipView.scroll(to: NSPoint(
            x: clipView.bounds.origin.x,
            y: max(0, textView.bounds.maxY - clipView.bounds.height)
        ))
        textView.enclosingScrollView?.reflectScrolledClipView(clipView)
        #expect(await waitUntil { !coordinator.isSelectionPanelVisible })
    }

    @Test("selection chrome rebinds when its window changes")
    func selectionChromeRebindsWindow() async throws {
        _ = NSApplication.shared
        let lines = (0..<40).map { "line \($0) target" }.joined(separator: "\n")
        let storage = RectoTextStorage(documentId: "selection-rebind", markdown: lines)
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let firstWindow = NSWindow(
            contentRect: NSRect(x: 120, y: 160, width: 620, height: 320),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        firstWindow.contentView = host
        firstWindow.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange((lines as NSString).range(of: "line 3 target"))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(firstWindow)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: firstWindow)
        #expect(coordinator.isSelectionPanelVisible)
        #expect(coordinator.selectionPanelParent === firstWindow)

        let secondWindow = NSWindow(
            contentRect: NSRect(x: 220, y: 220, width: 620, height: 320),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        defer { Self.retainedTransformWindows.append(secondWindow) }
        firstWindow.contentView = nil
        secondWindow.contentView = host
        secondWindow.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: secondWindow)
        #expect(coordinator.isSelectionPanelVisible)
        #expect(coordinator.selectionPanelParent === secondWindow)
        #expect((firstWindow.childWindows ?? []).isEmpty)
        expectSelectionPanelPosition(coordinator, controller: controller)

        coordinator.uninstall()
        #expect((firstWindow.childWindows ?? []).isEmpty)
        #expect((secondWindow.childWindows ?? []).isEmpty)
    }

    @Test("selection chrome rebinds before a replacement clip scrolls")
    func selectionChromeRebindsClipView() async throws {
        _ = NSApplication.shared
        let lines = (0..<40).map { "line \($0) target" }.joined(separator: "\n")
        let storage = RectoTextStorage(documentId: "selection-clip", markdown: lines)
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 160, width: 620, height: 320),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange((lines as NSString).range(of: "line 3 target"))
        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)

        let scrollView = try #require(textView.enclosingScrollView)
        let oldClipView = scrollView.contentView
        let oldClipViewNotificationSetting = oldClipView.postsBoundsChangedNotifications
        let replacementClipView = NSClipView(frame: oldClipView.frame)
        scrollView.contentView = replacementClipView
        scrollView.documentView = textView
        host.layoutSubtreeIfNeeded()
        let frameBeforeScroll = try #require(coordinator.selectionPanelFrame)
        replacementClipView.scroll(to: NSPoint(x: 0, y: 12))
        scrollView.reflectScrolledClipView(replacementClipView)
        NotificationCenter.default.post(
            name: NSView.boundsDidChangeNotification,
            object: replacementClipView
        )
        await drainMainQueue()
        await drainMainQueue()
        #expect(oldClipView.postsBoundsChangedNotifications == oldClipViewNotificationSetting)
        #expect(replacementClipView.postsBoundsChangedNotifications)
        #expect(await waitUntil {
            guard let frame = coordinator.selectionPanelFrame else { return false }
            return abs(frame.origin.y - frameBeforeScroll.origin.y) > 1
        })
    }

    @Test("selection chrome stays inside the anchor screen")
    func selectionChromeClampsToVisibleScreen() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "selection-screen", markdown: "Select me")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let visibleFrame = try #require(NSScreen.main?.visibleFrame)
        let window = NSWindow(
            contentRect: NSRect(x: visibleFrame.minX - 80, y: visibleFrame.maxY - 90, width: 240, height: 80),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 6))
        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        let panelFrame = try #require(coordinator.selectionPanelFrame)
        let anchorScreen = NSScreen.screens.first { $0.frame.intersects(panelFrame) } ?? NSScreen.main
        #expect(try #require(anchorScreen).visibleFrame.contains(panelFrame))
    }

    @Test("old view lifecycle notifications cannot move successor chrome")
    func staleSelectionChromeNotificationsAreIgnored() async throws {
        _ = NSApplication.shared
        let controller = RectoWritingController()
        let firstStorage = RectoTextStorage(documentId: "selection-old", markdown: "old selection")
        let firstHost = NSHostingView(rootView: RectoEditorView(
            storage: firstStorage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let firstWindow = NSWindow(contentViewController: NSViewController())
        firstWindow.contentView = firstHost
        firstWindow.makeKeyAndOrderFront(nil)
        firstHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let firstTextView = try #require(firstStorage.textView.nsTextView)
        firstTextView.setSelectedRange(NSRange(location: 0, length: 3))
        let firstClipView = try #require(firstTextView.enclosingScrollView?.contentView)
        let firstClipViewNotificationSetting = firstClipView.postsBoundsChangedNotifications

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(firstWindow)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: firstWindow)
        #expect(coordinator.isSelectionPanelVisible)
        #expect(firstClipView.postsBoundsChangedNotifications)
        NotificationCenter.default.post(name: NSWindow.didMoveNotification, object: firstWindow)

        let secondStorage = RectoTextStorage(documentId: "selection-new", markdown: "new selection")
        let secondHost = NSHostingView(rootView: RectoEditorView(
            storage: secondStorage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let secondWindow = NSWindow(contentViewController: NSViewController())
        secondWindow.contentView = secondHost
        secondWindow.makeKeyAndOrderFront(nil)
        defer { Self.retainedTransformWindows.append(secondWindow) }
        secondHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let secondTextView = try #require(secondStorage.textView.nsTextView)
        secondTextView.setSelectedRange(NSRange(location: 0, length: 3))
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: secondWindow)
        coordinator.refresh()
        #expect(coordinator.isSelectionPanelVisible)
        #expect(firstClipView.postsBoundsChangedNotifications == firstClipViewNotificationSetting)
        let successorFrame = try #require(coordinator.selectionPanelFrame)

        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: firstWindow)
        NotificationCenter.default.post(
            name: NSView.boundsDidChangeNotification,
            object: firstTextView.enclosingScrollView?.contentView
        )
        await drainMainQueue()
        await drainMainQueue()

        #expect(coordinator.isSelectionPanelVisible)
        #expect(coordinator.selectionPanelFrame == successorFrame)
        expectSelectionPanelPosition(coordinator, controller: controller)
    }

    @Test("destination input survives key focus and submits the link")
    func destinationInputSurvivesKeyFocus() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "destination-window", markdown: "Recto")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        coordinator.showSelectionLinkInput()
        await drainMainQueue()
        let field = try #require(NSApp.windows
            .flatMap(\.descendantViews)
            .compactMap { $0 as? NSTextField }
            .first { $0.placeholderString == "URL or path" && $0.window?.isVisible == true })
        let popoverWindow = try #require(field.window)
        popoverWindow.makeKey()
        #expect(popoverWindow.makeFirstResponder(field))
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        await drainMainQueue()

        #expect(coordinator.isInputPopoverShown)
        field.stringValue = "https://recto.example/path"
        NotificationCenter.default.post(name: NSControl.textDidChangeNotification, object: field)
        await drainMainQueue()
        let submitAction = try #require(field.action)
        #expect(NSApp.sendAction(submitAction, to: field.target, from: field))
        await drainMainQueue()

        #expect(storage.markdown == "[Recto](https://recto.example/path)")
    }

    @Test("app deactivation closes destination input after key focus")
    func appDeactivationClosesDestinationInput() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "destination-deactivation", markdown: "Recto")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        coordinator.showSelectionLinkInput()
        await drainMainQueue()
        let field = try #require(NSApp.windows
            .flatMap(\.descendantViews)
            .compactMap { $0 as? NSTextField }
            .first { $0.placeholderString == "URL or path" && $0.window?.isVisible == true })
        let popoverWindow = try #require(field.window)
        popoverWindow.makeKey()
        #expect(popoverWindow.makeFirstResponder(field))
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        await drainMainQueue()
        #expect(popoverWindow.isVisible)

        NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
        coordinator.refresh()
        controller.refreshSelectionGeometry()

        #expect(await waitUntil { !popoverWindow.isVisible })
    }

    @Test("owner window close dismisses destination input")
    func ownerWindowCloseDismissesDestinationInput() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "destination-close", markdown: "Recto")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        coordinator.showSelectionLinkInput()
        await drainMainQueue()
        #expect(coordinator.isInputPopoverShown)

        let foreignWindow = NSWindow(contentViewController: NSViewController())
        defer { Self.retainedTransformWindows.append(foreignWindow) }
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: foreignWindow)
        #expect(coordinator.isInputPopoverShown)

        window.close()
        await drainMainQueue()
        #expect(!coordinator.isInputPopoverShown)
    }

    @Test("selection chrome stays hidden while inactive and returns after activation")
    func selectionChromeFollowsApplicationLifecycle() async throws {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "selection-app-lifecycle", markdown: "Select me")
        let controller = RectoWritingController()
        let host = NSHostingView(rootView: RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 6))

        let coordinator = WritingControlsHost.Coordinator(controller: controller)
        coordinator.install()
        defer {
            coordinator.uninstall()
            Self.retainedTransformWindows.append(window)
        }
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        #expect(coordinator.isSelectionPanelVisible)

        NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
        coordinator.refresh()
        controller.refreshSelectionGeometry()
        await drainMainQueue()
        #expect(!coordinator.isSelectionPanelVisible)

        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        #expect(coordinator.isSelectionPanelVisible)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<20 {
            if condition() { return true }
            await drainMainQueue()
        }
        return condition()
    }

    private func selectionPanelMatchesPosition(
        _ coordinator: WritingControlsHost.Coordinator,
        controller: RectoWritingController
    ) -> Bool {
        guard let panelFrame = coordinator.selectionPanelFrame,
              let anchor = controller.selectionState.anchorRect,
              let textView = controller.attachedTextView,
              let window = textView.window else { return false }
        let visibleAnchor = anchor.intersection(textView.visibleRect)
        guard !visibleAnchor.isNull, !visibleAnchor.isEmpty else { return false }
        let screenRect = window.convertToScreen(textView.convert(visibleAnchor, to: nil))
        return abs(panelFrame.origin.x - (screenRect.midX - panelFrame.width / 2)) < 1
            && abs(panelFrame.origin.y - (screenRect.maxY + 8)) < 1
    }

    private func expectSelectionPanelPosition(
        _ coordinator: WritingControlsHost.Coordinator,
        controller: RectoWritingController
    ) {
        guard let panelFrame = coordinator.selectionPanelFrame,
              let anchor = controller.selectionState.anchorRect,
              let textView = controller.attachedTextView,
              let window = textView.window else {
            Issue.record("selection panel geometry is unavailable")
            return
        }
        let visibleAnchor = anchor.intersection(textView.visibleRect)
        guard !visibleAnchor.isNull, !visibleAnchor.isEmpty else {
            Issue.record("selection anchor is offscreen")
            return
        }
        let screenRect = window.convertToScreen(textView.convert(visibleAnchor, to: nil))
        #expect(abs(panelFrame.origin.x - (screenRect.midX - panelFrame.width / 2)) < 1)
        #expect(abs(panelFrame.origin.y - (screenRect.maxY + 8)) < 1)
    }

}

private extension NSView {
    var descendantViews: [NSView] {
        [self] + subviews.flatMap(\.descendantViews)
    }
}

private extension NSWindow {
    var descendantViews: [NSView] {
        contentView?.descendantViews ?? []
    }
}
