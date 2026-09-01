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

    @Test("formatting does not rewrite container-indented code")
    func formattingRejectsContainerIndentedCode() {
        for markdown in [
            ">     literal", "-     literal", "1.     literal",
            ">   \tliteral", "-   \tliteral", "1.   \tliteral",
            "> \t    literal", "- \t    literal", "1. \t    literal",
        ] {
            let selection = (markdown as NSString).range(of: "literal")
            for command in [
                RectoEditorCommand.bold,
                .italic,
                .strikethrough,
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

    @Test("multiline formatting does not cross container-indented code")
    func multilineFormattingRejectsContainerIndentedCode() {
        for separator in ["\n", "\r\n"] {
            for codeLine in [">     literal", "-     literal", "1.     literal"] {
                let markdown = "prose\(separator)\(codeLine)\(separator)tail"
                let selection = (markdown as NSString).range(of: "prose\(separator)\(codeLine)")
                for command in [
                    RectoEditorCommand.bold,
                    .italic,
                    .strikethrough,
                    .heading(level: 1),
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

    @Test("plain text between marked runs is not active")
    func separateInlineRuns() {
        let cases: [(String, RectoEditorCommand)] = [
            ("**one** gap **two**", .bold),
            ("_one_ gap _two_", .italic),
            ("~~one~~ gap ~~two~~", .strikethrough),
            ("`one` gap `two`", .inlineCode),
        ]
        for (markdown, command) in cases {
            let selection = (markdown as NSString).range(of: "gap")
            #expect(!RectoCommandTransformer.activeInlineCommands(
                markdown: markdown,
                selection: selection
            ).contains(command))
        }
    }

    @Test("active marks follow parsed delimiter grammar")
    func parsedDelimiterGrammar() throws {
        for markdown in [
            "snake_case_value",
            #"snake\_case_value"#,
            "** one **",
            #"\*\*literal\*\*"#,
            "~~~strike~~~",
        ] {
            let selection = (markdown as NSString).range(of: "case").location == NSNotFound
                ? (markdown as NSString).range(of: "literal").location == NSNotFound
                    ? (markdown as NSString).range(of: "strike")
                    : (markdown as NSString).range(of: "literal")
                : (markdown as NSString).range(of: "case")
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: markdown,
                selection: selection
            ).isEmpty)
        }

        let spacedStrike = "~~ strike ~~"
        #expect(RectoCommandTransformer.activeInlineCommands(
            markdown: spacedStrike,
            selection: (spacedStrike as NSString).range(of: "strike")
        ) == [.strikethrough])

        let identifier = "snake_case_value"
        let selection = (identifier as NSString).range(of: "case")
        let edit = try #require(RectoCommandTransformer.edit(
            command: .italic,
            markdown: identifier,
            selection: selection
        ))
        #expect(edit.patch.replacement == "_case_")
        #expect((identifier as NSString).replacingCharacters(
            in: edit.patch.range,
            with: edit.patch.replacement
        ) == "snake__case__value")
    }

    @Test("all parsed code contexts reject non-code commands")
    func parsedCodeContexts() {
        for markdown in [
            "    literal",
            "`**literal**`",
            "> ```swift\n> literal\n> ```",
            "- ~~~swift\n  literal\n  ~~~",
            "> - ```swift\n>   literal\n>   ```",
            "1. > ~~~swift\n   > literal\n   > ~~~",
            "- parent\n  - ```\n    before\n\n\n    literal\n    ```",
            "> ```swift\n> literal",
        ] {
            let selection = (markdown as NSString).range(of: "literal")
            for command in [
                RectoEditorCommand.bold,
                .italic,
                .strikethrough,
                .heading(level: 2),
                .bulletList,
                .blockquote,
            ] {
                #expect(RectoCommandTransformer.edit(
                    command: command,
                    markdown: markdown,
                    selection: selection
                ) == nil)
            }
        }

        let inline = "`**literal**`"
        let selection = (inline as NSString).range(of: "literal")
        #expect(RectoCommandTransformer.activeInlineCommands(
            markdown: inline,
            selection: selection
        ) == [.inlineCode])
        #expect(RectoCommandTransformer.edit(
            command: .inlineCode,
            markdown: inline,
            selection: selection
        ) != nil)

        for code in ["```swift\nliteral", "    literal"] {
            let eof = NSRange(location: (code as NSString).length, length: 0)
            for command in [
                RectoEditorCommand.bold,
                .italic,
                .strikethrough,
                .heading(level: 2),
                .bulletList,
                .blockquote,
            ] {
                #expect(RectoCommandTransformer.edit(
                    command: command,
                    markdown: code,
                    selection: eof
                ) == nil)
            }
        }

        let closed = "```\nliteral\n```"
        let closedEOF = NSRange(location: (closed as NSString).length, length: 0)
        #expect(RectoCommandTransformer.edit(
            command: .bold,
            markdown: closed,
            selection: closedEOF
        ) != nil)
    }

    @Test("slash menu stays closed in container fences but not after deindent")
    func containerFenceSlashContext() {
        for markdown in [
            "> ```\n> /heading\n> ```",
            "- ~~~\n  /heading\n  ~~~",
            "> - ```\n>   /heading\n>   ```",
            "- parent\n  - ```\n    before\n\n\n    /heading\n    ```",
            "> ```\n> /heading",
        ] {
            let caret = (markdown as NSString).range(of: "/heading").upperBound
            #expect(RectoSlashMenu.state(
                markdown: markdown,
                selection: NSRange(location: caret, length: 0),
                selectedIndex: 0,
                anchorRect: nil
            ) == nil)
        }

        let deindented = "> ```\n> code\n/heading"
        let caret = (deindented as NSString).length
        #expect(RectoSlashMenu.state(
            markdown: deindented,
            selection: NSRange(location: caret, length: 0),
            selectedIndex: 0,
            anchorRect: nil
        ) != nil)
    }

    @Test("partial outer mark removal preserves nested semantics")
    func nestedOuterRemoval() throws {
        let markdown = "**bold _and italic_ end**"
        let selection = (markdown as NSString).range(of: "and italic")
        let edit = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: markdown,
            selection: selection
        ))
        let result = (markdown as NSString).replacingCharacters(
            in: edit.patch.range,
            with: edit.patch.replacement
        )
        #expect((result as NSString).substring(with: edit.selection) == "and italic")
        #expect(MarkdownHTMLRenderer.html(from: result) == "<p><strong>bold</strong> <em>and italic</em> <strong>end</strong></p>")

        let repeated = "**_foo foo_**"
        let firstFoo = (repeated as NSString).range(of: "foo")
        let secondFoo = (repeated as NSString).range(
            of: "foo",
            options: [],
            range: NSRange(
                location: NSMaxRange(firstFoo),
                length: (repeated as NSString).length - NSMaxRange(firstFoo)
            )
        )
        let repeatedEdit = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: repeated,
            selection: secondFoo
        ))
        let repeatedResult = (repeated as NSString).replacingCharacters(
            in: repeatedEdit.patch.range,
            with: repeatedEdit.patch.replacement
        )
        #expect(repeatedResult == "**_foo_** _foo_")
        #expect(repeatedEdit.selection.location == (repeatedResult as NSString).range(
            of: "foo",
            options: .backwards
        ).location)
        #expect((repeatedResult as NSString).substring(with: repeatedEdit.selection) == "foo")
        #expect(MarkdownHTMLRenderer.html(from: repeatedResult) == "<p><strong><em>foo</em></strong> <em>foo</em></p>")

        let partialNested = "**_foo bar_**"
        let bar = (partialNested as NSString).range(of: "bar")
        let partialEdit = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: partialNested,
            selection: bar
        ))
        let partialResult = (partialNested as NSString).replacingCharacters(
            in: partialEdit.patch.range,
            with: partialEdit.patch.replacement
        )
        #expect((partialResult as NSString).substring(with: partialEdit.selection) == "bar")
        #expect(MarkdownHTMLRenderer.html(from: partialResult) == "<p><strong><em>foo</em></strong> <em>bar</em></p>")
    }

    @Test("partial outer removal preserves every deeper mark")
    func deeplyNestedOuterRemoval() throws {
        let cases: [(String, RectoEditorCommand, Set<RectoEditorCommand>)] = [
            ("**_~~foo bar~~_**", .bold, [.italic, .strikethrough]),
            ("_**~~foo bar~~**_", .italic, [.bold, .strikethrough]),
            ("~~**_foo bar_**~~", .strikethrough, [.bold, .italic]),
            ("***~~foo bar~~***", .bold, [.italic, .strikethrough]),
            ("***~~foo bar~~***", .italic, [.bold, .strikethrough]),
        ]

        for (markdown, command, selectedCommands) in cases {
            let selection = (markdown as NSString).range(of: "bar")
            let edit = try #require(RectoCommandTransformer.edit(
                command: command,
                markdown: markdown,
                selection: selection
            ))
            let result = (markdown as NSString).replacingCharacters(
                in: edit.patch.range,
                with: edit.patch.replacement
            )
            #expect((result as NSString).substring(with: edit.selection) == "bar")
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: result,
                selection: edit.selection
            ) == selectedCommands)
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: result,
                selection: (result as NSString).range(of: "foo")
            ) == [.bold, .italic, .strikethrough])
        }
    }

    @Test("bold italic reports and removes either semantic independently")
    func boldItalicToggles() throws {
        let markdown = "***both***"
        let selection = (markdown as NSString).range(of: "both")
        #expect(RectoCommandTransformer.activeInlineCommands(
            markdown: markdown,
            selection: selection
        ) == [.bold, .italic])

        for (command, html) in [
            (RectoEditorCommand.bold, "<p><em>both</em></p>"),
            (.italic, "<p><strong>both</strong></p>"),
        ] {
            let edit = try #require(RectoCommandTransformer.edit(
                command: command,
                markdown: markdown,
                selection: selection
            ))
            let result = (markdown as NSString).replacingCharacters(
                in: edit.patch.range,
                with: edit.patch.replacement
            )
            #expect(MarkdownHTMLRenderer.html(from: result) == html)
            #expect((result as NSString).substring(with: edit.selection) == "both")
        }
    }

    @Test("table cell marks keep source coordinates")
    func tableCellMarks() {
        let markdown = "| **bold** | `code` | ~~strike~~ |\n| --- | --- | --- |"
        for (needle, command) in [
            ("bold", RectoEditorCommand.bold),
            ("code", .inlineCode),
            ("strike", .strikethrough),
        ] {
            let selection = (markdown as NSString).range(of: needle)
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: markdown,
                selection: selection
            ).contains(command))
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
