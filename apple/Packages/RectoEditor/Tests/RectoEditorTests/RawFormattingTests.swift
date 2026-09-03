import AppKit
import Testing
@testable import RectoEditor

/// Formatting commands in raw. The web's raw toolbar wraps Markdown, and so
/// must ours: raw's promise about typing is about smart input, not about an
/// explicit command. These mount the same document in rich and raw and hold
/// the results to the same bytes and the same selection.
@MainActor
@Suite("Formatting in raw", .serialized)
struct RawFormattingTests {
    private struct Mounted {
        let storage: RectoTextStorage
        let controller: RectoWritingController
        let harness: WindowHarness
        let textView: NSTextView
    }

    private func mount(_ markdown: String, presentation: Presentation, id: String,
                       storage: RectoTextStorage? = nil,
                       onEdit: ((RectoEditorEdit) -> Void)? = nil) throws -> Mounted {
        let storage = storage ?? RectoTextStorage(documentId: "\(id)-\(presentation.rawValue)", markdown: markdown)
        let controller = RectoWritingController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: presentation, theme: .twilight, undo: .external),
                onEdit: onEdit,
                writingController: controller
            ),
            size: CGSize(width: 640, height: 320)
        )
        let textView = try #require(harness.editorTextView)
        return Mounted(storage: storage, controller: controller, harness: harness, textView: textView)
    }

    /// Run `command` on `selection` in rich and in raw; both must land the same.
    private func expectSameInRichAndRaw(
        _ markdown: String,
        selection: NSRange,
        command: RectoEditorCommand,
        expected: String,
        expectedSelection: NSRange,
        id: String
    ) throws {
        for presentation in [Presentation.rich, .raw] {
            let mounted = try mount(markdown, presentation: presentation, id: id)
            defer { mounted.harness.tearDown() }
            mounted.textView.setSelectedRange(selection)
            #expect(mounted.controller.perform(command), "\(presentation)")
            #expect(mounted.storage.markdown == expected, "\(presentation)")
            #expect(mounted.textView.string == expected, "\(presentation)")
            #expect(mounted.textView.selectedRange() == expectedSelection, "\(presentation)")
        }
    }

    @Test("inline commands wrap a raw selection exactly as in rich")
    func inlineCommands() throws {
        let markdown = "Write 😀 now"
        let selection = (markdown as NSString).range(of: "😀")
        try expectSameInRichAndRaw(markdown, selection: selection, command: .bold,
                                   expected: "Write **😀** now",
                                   expectedSelection: NSRange(location: selection.location + 2, length: 2), id: "bold")
        try expectSameInRichAndRaw(markdown, selection: selection, command: .italic,
                                   expected: "Write _😀_ now",
                                   expectedSelection: NSRange(location: selection.location + 1, length: 2), id: "italic")
        try expectSameInRichAndRaw(markdown, selection: selection, command: .inlineCode,
                                   expected: "Write `😀` now",
                                   expectedSelection: NSRange(location: selection.location + 1, length: 2), id: "code")
        try expectSameInRichAndRaw(markdown, selection: selection, command: .strikethrough,
                                   expected: "Write ~~😀~~ now",
                                   expectedSelection: NSRange(location: selection.location + 2, length: 2), id: "strike")
    }

    @Test("block commands rewrite the raw line exactly as in rich")
    func blockCommands() throws {
        let markdown = "alpha\nbeta\n"
        let caret = NSRange(location: 2, length: 0)
        try expectSameInRichAndRaw(markdown, selection: caret, command: .heading(level: 2),
                                   expected: "## alpha\nbeta\n",
                                   expectedSelection: NSRange(location: 5, length: 0), id: "heading")
        try expectSameInRichAndRaw(markdown, selection: caret, command: .bulletList,
                                   expected: "- alpha\nbeta\n",
                                   expectedSelection: NSRange(location: 4, length: 0), id: "bullet")
        try expectSameInRichAndRaw(markdown, selection: caret, command: .orderedList,
                                   expected: "1. alpha\nbeta\n",
                                   expectedSelection: NSRange(location: 5, length: 0), id: "ordered")
        try expectSameInRichAndRaw(markdown, selection: caret, command: .blockquote,
                                   expected: "> alpha\nbeta\n",
                                   expectedSelection: NSRange(location: 4, length: 0), id: "quote")
    }

    @Test("generated blocks and links use the same defaults in raw")
    func generatedContent() throws {
        for presentation in [Presentation.rich, .raw] {
            let code = try mount("hello", presentation: presentation, id: "codeblock")
            defer { code.harness.tearDown() }
            code.textView.setSelectedRange(NSRange(location: 5, length: 0))
            #expect(code.controller.perform(.codeBlock(language: "")))
            #expect(code.storage.markdown.hasPrefix("hello\n\n```\n"), "\(presentation): \(code.storage.markdown)")
            #expect(code.storage.markdown.hasSuffix("\n```"), "\(presentation): \(code.storage.markdown)")

            let link = try mount("hello", presentation: presentation, id: "link")
            defer { link.harness.tearDown() }
            link.textView.setSelectedRange(NSRange(location: 0, length: 5))
            #expect(link.controller.perform(.link(destination: "https://example.com")))
            #expect(link.storage.markdown == "[hello](https://example.com)", "\(presentation)")
            #expect(link.textView.selectedRange() == NSRange(location: 1, length: 5), "\(presentation)")
        }
    }

    @Test("a raw command is one structural edit the owner can undo")
    func undoRestores() throws {
        let original = "Recto"
        let storage = RectoTextStorage(documentId: "undo-raw", markdown: original)
        let manager = UndoManager()
        storage.controller.undoManager = manager
        var edits: [RectoEditorEdit] = []
        var current = original
        // The app owns undo (`undo: .external`); this is the smallest owner that
        // does what the app's does: snapshot the previous text per published edit.
        let mounted = try mount(original, presentation: .raw, id: "undo", storage: storage) { edit in
            edits.append(edit)
            let previous = current
            current = edit.markdown
            manager.registerUndo(withTarget: storage) { $0.markdown = previous }
        }
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 5))

        #expect(mounted.controller.perform(.bold))
        #expect(edits == [RectoEditorEdit(markdown: "**Recto**", structural: true)])
        #expect(manager.canUndo)

        manager.undo()
        #expect(mounted.storage.markdown == original)
        #expect(mounted.textView.string == original)
    }

    @Test("preview stays inert")
    func previewIsInert() throws {
        let mounted = try mount("hello", presentation: .preview, id: "preview")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 5))
        #expect(!mounted.controller.perform(.bold))
        #expect(!mounted.controller.perform(.heading(level: 1)))
        #expect(mounted.storage.markdown == "hello")
    }

    @Test("the selection bar and slash menu stay rich-only")
    func smartInputStaysRich() throws {
        let raw = try mount("hello", presentation: .raw, id: "smart-raw")
        defer { raw.harness.tearDown() }
        raw.textView.setSelectedRange(NSRange(location: 0, length: 5))
        raw.controller.refreshSelectionGeometry()
        #expect(raw.controller.selectionState.hasSelection)
        #expect(!raw.controller.selectionState.canFormatSelection, "raw has no floating format bar")

        raw.textView.setSelectedRange(NSRange(location: 5, length: 0))
        raw.textView.insertText("\n/hea", replacementRange: NSRange(location: 5, length: 0))
        #expect(raw.textView.string == "hello\n/hea")
        #expect(raw.controller.slashMenuState == nil, "raw has no slash menu")

        let rich = try mount("hello", presentation: .rich, id: "smart-rich")
        defer { rich.harness.tearDown() }
        rich.textView.setSelectedRange(NSRange(location: 0, length: 5))
        rich.controller.refreshSelectionGeometry()
        #expect(rich.controller.selectionState.canFormatSelection)
        rich.textView.setSelectedRange(NSRange(location: 5, length: 0))
        rich.textView.insertText("\n/hea", replacementRange: NSRange(location: 5, length: 0))
        #expect(rich.controller.slashMenuState?.query == "hea")
    }
}
