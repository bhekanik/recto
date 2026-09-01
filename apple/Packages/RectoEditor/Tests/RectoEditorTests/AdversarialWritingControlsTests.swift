import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("Adversarial writing controls")
struct AdversarialWritingControlsTests {
    @Test("formatting does not rewrite fenced code contents")
    func formattingRejectsFencedCodeContents() {
        let markdown = "```swift\nlet value = \"**literal**\"\n```"
        let selection = (markdown as NSString).range(of: "let value")

        for command in [
            RectoEditorCommand.bold,
            .italic,
            .strikethrough,
            .heading(level: 2),
            .bulletList,
            .orderedList,
            .taskList,
            .blockquote,
        ] {
            #expect(RectoCommandTransformer.edit(
                command: command,
                markdown: markdown,
                selection: selection
            ) == nil)
        }
    }

    @Test("slash menu does not open inside fenced code")
    func slashRejectsFencedCodeContents() {
        for markdown in ["```text\n/heading\n```", "~~~text\n/heading\n~~~", "```\n/heading"] {
            let caret = (markdown as NSString).range(of: "/heading").upperBound
            #expect(RectoSlashMenu.state(
                markdown: markdown,
                selection: NSRange(location: caret, length: 0),
                selectedIndex: 0,
                anchorRect: nil
            ) == nil)
        }
    }

    @Test("line formatting does not rewrite container-indented code")
    func formattingRejectsContainerIndentedCode() {
        for markdown in [">     literal", "-     literal", "1.     literal"] {
            let selection = (markdown as NSString).range(of: "literal")
            for command in [
                RectoEditorCommand.heading(level: 1),
                .bulletList,
                .orderedList,
                .taskList,
                .blockquote,
            ] {
                #expect(RectoCommandTransformer.edit(
                    command: command,
                    markdown: markdown,
                    selection: selection
                ) == nil)
            }
        }
    }

    @Test("line formatting preserves post-marker indentation")
    func lineFormattingPreservesPostMarkerIndentation() throws {
        let list = "-   child"
        let ordered = try #require(RectoCommandTransformer.edit(
            command: .orderedList,
            markdown: list,
            selection: (list as NSString).range(of: "child")
        ))
        #expect(ordered.patch.replacement == "1.   child")

        let heading = try #require(RectoCommandTransformer.edit(
            command: .heading(level: 2),
            markdown: list,
            selection: (list as NSString).range(of: "child")
        ))
        #expect(heading.patch.replacement == "-   ## child")

        let quote = ">   child"
        let unquoted = try #require(RectoCommandTransformer.edit(
            command: .blockquote,
            markdown: quote,
            selection: (quote as NSString).range(of: "child")
        ))
        #expect(unquoted.patch.replacement == "  child")
    }

    @Test("delimiter content, Unicode, and no-result slash queries are non-destructive")
    func edgeInputsAreNonDestructive() throws {
        for item in [
            (RectoEditorCommand.bold, "left ** right"),
            (.italic, "left _ right"),
            (.strikethrough, "left ~~ right"),
        ] {
            #expect(RectoCommandTransformer.edit(
                command: item.0,
                markdown: item.1,
                selection: NSRange(location: 0, length: (item.1 as NSString).length)
            ) == nil)
        }

        let unicode = "a`e\u{301}😀`z"
        let code = try #require(RectoCommandTransformer.edit(
            command: .inlineCode,
            markdown: unicode,
            selection: NSRange(location: 0, length: (unicode as NSString).length)
        ))
        #expect((code.patch.replacement as NSString).substring(with: code.selection) == unicode)

        let noResult = "/definitely-no-command"
        #expect(RectoSlashMenu.state(
            markdown: noResult,
            selection: NSRange(location: (noResult as NSString).length, length: 0),
            selectedIndex: 0,
            anchorRect: nil
        ) == nil)
    }

    @Test("active marks include enclosing inline syntax")
    func activeMarksIncludeEnclosingSyntax() {
        let cases: [(String, String, Set<RectoEditorCommand>)] = [
            ("**bold**", "ol", [.bold]),
            ("_italic_", "tal", [.italic]),
            ("~~strike~~", "tri", [.strikethrough]),
            ("`inline code`", "line", [.inlineCode]),
            ("**bold _and italic_ end**", "and italic", [.bold, .italic]),
        ]
        for (markdown, needle, expected) in cases {
            let selection = (markdown as NSString).range(of: needle)
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: markdown,
                selection: selection
            ) == expected)
        }
    }

    @Test("partial inline toggles change rendered semantics and preserve selection")
    func partialInlineToggles() throws {
        let cases: [(String, String, RectoEditorCommand, String)] = [
            ("**bold**", "ol", .bold, "<p><strong>b</strong>ol<strong>d</strong></p>"),
            ("_italic_", "tal", .italic, "<p><em>i</em>tal<em>ic</em></p>"),
            ("~~strike~~", "tri", .strikethrough, "<p><del>s</del>tri<del>ke</del></p>"),
            ("`inline code`", "line", .inlineCode, "<p><code>in</code>line<code> code</code></p>"),
        ]

        for (markdown, needle, command, expectedHTML) in cases {
            let selection = (markdown as NSString).range(of: needle)
            let edit = try #require(RectoCommandTransformer.edit(
                command: command,
                markdown: markdown,
                selection: selection
            ))
            let result = (markdown as NSString).replacingCharacters(
                in: edit.patch.range,
                with: edit.patch.replacement
            )
            let selected = (result as NSString).substring(with: edit.selection)
            #expect(selected == needle)
            #expect(MarkdownHTMLRenderer.html(
                from: result,
                extensions: [StrikethroughExtension()]
            ) == expectedHTML)
        }
    }

    @Test("one mark nests inside another while crossing delimiters refuses safely")
    func nestingAndCrossingInlineMarks() throws {
        let markdown = "**bold**"
        let selection = (markdown as NSString).range(of: "bold")
        let nested = try #require(RectoCommandTransformer.edit(
            command: .italic,
            markdown: markdown,
            selection: selection
        ))
        let nestedResult = (markdown as NSString).replacingCharacters(
            in: nested.patch.range,
            with: nested.patch.replacement
        )
        #expect(nestedResult == "**_bold_**")
        #expect((nestedResult as NSString).substring(with: nested.selection) == "bold")
        #expect(MarkdownHTMLRenderer.html(from: nestedResult) == "<p><strong><em>bold</em></strong></p>")

        let crossing = "**bold _and italic_ end**"
        let crossingSelection = (crossing as NSString).range(of: "bold _and")
        #expect(RectoCommandTransformer.edit(
            command: .italic,
            markdown: crossing,
            selection: crossingSelection
        ) == nil)
    }

    @Test("escape dismissal survives geometry refresh")
    func slashDismissalPersists() throws {
        let storage = RectoTextStorage(documentId: "slash-dismiss", markdown: "/h1")
        let controller = RectoWritingController()
        let harness = WindowHarness(RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            writingController: controller
        ))
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        textView.setSelectedRange(NSRange(location: 3, length: 0))
        #expect(controller.slashMenuState != nil)

        controller.dismissSlashMenu()
        #expect(controller.slashMenuState == nil)
        controller.refreshSelectionGeometry()
        #expect(controller.slashMenuState == nil)

        textView.setSelectedRange(NSRange(location: 2, length: 0))
        #expect(controller.slashMenuState != nil)
    }
}
