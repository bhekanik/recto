//
//  FindControllerTests.swift
//  RectoEditorTests
//

import AppKit
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("System Find", .serialized)
struct FindControllerTests {
    private struct MountedFind {
        let harness: WindowHarness
        let storage: RectoTextStorage
        let controller: RectoFindController
        let textView: NSTextView
    }

    private func mount(
        markdown: String,
        presentation: Presentation = .rich
    ) throws -> MountedFind {
        let storage = RectoTextStorage(documentId: "find", markdown: markdown)
        let controller = RectoFindController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: presentation, theme: .twilight),
                onAttach: { controller.attach(to: $0) }
            ),
            size: CGSize(width: 640, height: 320)
        )
        return MountedFind(
            harness: harness,
            storage: storage,
            controller: controller,
            textView: try #require(harness.editorTextView)
        )
    }

    @Test("rich Find sees the reader text, not hidden source")
    func richFindUsesProjection() throws {
        let markdown = """
        ---
        title: Hidden metadata
        ---
        # Alpha [bravo](https://secret.example)
        """
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }

        #expect(mounted.controller.string == "Alpha bravo")
        #expect(!mounted.controller.string.contains("Hidden metadata"))
        #expect(!mounted.controller.string.contains("secret.example"))
    }

    @Test("raw Find is an identity view of the file")
    func rawFindUsesSource() throws {
        let markdown = "# Alpha [bravo](https://secret.example)\n"
        let mounted = try mount(markdown: markdown, presentation: .raw)
        defer { mounted.harness.tearDown() }

        #expect(mounted.controller.string == markdown)
    }

    @Test("selection maps between visible and source coordinates")
    func selectionMapping() throws {
        let markdown = "# Alpha [bravo](https://secret.example)\n"
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let sourceRange = (markdown as NSString).range(of: "bravo")
        let visibleRange = (mounted.controller.string as NSString).range(of: "bravo")

        mounted.textView.setSelectedRange(sourceRange)
        #expect(mounted.controller.firstSelectedRange == visibleRange)

        let alphaVisible = (mounted.controller.string as NSString).range(of: "Alpha")
        mounted.controller.selectedRanges = [NSValue(range: alphaVisible)]
        #expect(mounted.textView.selectedRange() == (markdown as NSString).range(of: "Alpha"))
    }

    @Test("replace maps to source and preserves surrounding Markdown")
    func replacementPreservesSyntax() throws {
        let markdown = "# Alpha [bravo](https://secret.example)\n"
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let visibleRange = (mounted.controller.string as NSString).range(of: "bravo")

        #expect(mounted.controller.shouldReplaceCharacters(
            inRanges: [NSValue(range: visibleRange)],
            with: ["BRAVO"]
        ))
        mounted.controller.replaceCharacters(in: visibleRange, with: "BRAVO")
        mounted.controller.didReplaceCharacters()

        #expect(mounted.textView.string == "# Alpha [BRAVO](https://secret.example)\n")
    }

    @Test("replace all enters through one batch")
    func replacementBatch() throws {
        let markdown = "**alpha** and [alpha](https://example.com)\n"
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let visible = mounted.controller.string as NSString
        let first = visible.range(of: "alpha")
        let second = visible.range(
            of: "alpha",
            options: [],
            range: NSRange(location: NSMaxRange(first), length: visible.length - NSMaxRange(first))
        )
        let ranges = [first, second]

        #expect(mounted.controller.shouldReplaceCharacters(
            inRanges: ranges.map(NSValue.init(range:)),
            with: ["one", "two"]
        ))
        for (range, replacement) in zip(ranges.reversed(), ["two", "one"]) {
            mounted.controller.replaceCharacters(in: range, with: replacement)
        }
        mounted.controller.didReplaceCharacters()

        #expect(mounted.textView.string == "**one** and [two](https://example.com)\n")
    }

    @Test("the standard responder action opens AppKit's Find bar")
    func standardActionOpensFindBar() throws {
        let mounted = try mount(markdown: "Alpha bravo\n")
        defer { mounted.harness.tearDown() }
        let scrollView = try #require(mounted.textView.enclosingScrollView)
        let item = NSMenuItem(
            title: "Find",
            action: #selector(NSTextView.performTextFinderAction(_:)),
            keyEquivalent: ""
        )
        item.tag = NSTextFinder.Action.showFindInterface.rawValue

        mounted.textView.performTextFinderAction(item)
        mounted.harness.layout(passes: 2)

        #expect(scrollView.findBarView != nil)
        #expect(scrollView.isFindBarVisible)
    }

    @Test("detach removes the engine responder")
    func detachClearsResponder() throws {
        let mounted = try mount(markdown: "Alpha bravo\n")
        defer { mounted.harness.tearDown() }
        #expect(mounted.storage.controller.textFinderActionResponder === mounted.controller)

        mounted.controller.attach(to: nil)

        #expect(mounted.storage.controller.textFinderActionResponder == nil)
    }
}
