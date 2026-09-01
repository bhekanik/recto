import Foundation
import Testing
@testable import RectoEditor

private struct SlashFixture: Decodable {
    struct Entry: Decodable {
        struct Insertion: Decodable {
            let kind: String
            let level: Int?
            let text: String?
            let block: String?
            let inner: String?
            let language: String?
            let rows: Int?
            let columns: Int?
        }
        let id: String
        let label: String
        let aliases: [String]
        let insertion: Insertion
    }
    let clearCurrentBlock: Bool
    let entries: [Entry]
}

@MainActor
@Suite("Writing controls", .serialized)
struct WritingControlsTests {
    @Test("inline commands preserve UTF-16 selections and toggle")
    func inlineCommands() throws {
        let markdown = "Write 😀 now"
        let selection = (markdown as NSString).range(of: "😀")
        let wrapped = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: markdown,
            selection: selection
        ))
        #expect(wrapped.patch.replacement == "**😀**")
        #expect(wrapped.selection == NSRange(location: selection.location + 2, length: 2))

        let boldMarkdown = "Write **😀** now"
        let boldSelection = (boldMarkdown as NSString).range(of: "😀")
        let unwrapped = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: boldMarkdown,
            selection: boldSelection
        ))
        #expect(unwrapped.patch.range == (boldMarkdown as NSString).range(of: "**😀**"))
        #expect(unwrapped.patch.replacement == "😀")

        let spaced = " hello "
        let spacedEdit = try #require(RectoCommandTransformer.edit(
            command: .bold,
            markdown: spaced,
            selection: NSRange(location: 0, length: (spaced as NSString).length)
        ))
        #expect(spacedEdit.patch.replacement == " **hello** ")
        #expect(spacedEdit.selection == NSRange(location: 3, length: 5))

        for unsupported in ["first\n\nsecond", "first\r\n\r\nsecond", " \t "] {
            #expect(RectoCommandTransformer.edit(
                command: .bold,
                markdown: unsupported,
                selection: NSRange(location: 0, length: (unsupported as NSString).length)
            ) == nil)
        }
        for item in [
            (RectoEditorCommand.bold, "a**b"),
            (.italic, "a_b"),
            (.strikethrough, "a~~b"),
        ] {
            #expect(RectoCommandTransformer.edit(
                command: item.0,
                markdown: item.1,
                selection: NSRange(location: 0, length: (item.1 as NSString).length)
            ) == nil)
        }
    }

    @Test("block commands replace an existing block prefix")
    func blockCommands() throws {
        let markdown = "# First\n- Second\n"
        let edit = try #require(RectoCommandTransformer.edit(
            command: .orderedList,
            markdown: markdown,
            selection: NSRange(location: 0, length: (markdown as NSString).length)
        ))
        #expect(edit.patch.replacement == "1. # First\n1. Second\n")

        let empty = try #require(RectoCommandTransformer.edit(
            command: .heading(level: 2),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ))
        #expect(empty.patch.replacement == "## ")
        #expect(empty.selection == NSRange(location: 3, length: 0))

        let emptyQuote = try #require(RectoCommandTransformer.edit(
            command: .blockquote,
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ))
        #expect(emptyQuote.patch.replacement == "> ")
        #expect(emptyQuote.selection == NSRange(location: 2, length: 0))

        let lineBoundary = "first\nsecond\n"
        let firstLineOnly = try #require(RectoCommandTransformer.edit(
            command: .bulletList,
            markdown: lineBoundary,
            selection: NSRange(location: 0, length: 6)
        ))
        #expect(firstLineOnly.patch.replacement == "- first\n")
        #expect(firstLineOnly.patch.range == NSRange(location: 0, length: 6))

        let oversizedMarker = "1234567890. keep me"
        let bullet = try #require(RectoCommandTransformer.edit(
            command: .bulletList,
            markdown: oversizedMarker,
            selection: NSRange(location: 0, length: (oversizedMarker as NSString).length)
        ))
        #expect(bullet.patch.replacement == "- 1234567890. keep me")

        let carriageReturns = "first\rsecond\r"
        let divider = try #require(RectoCommandTransformer.edit(
            command: .divider,
            markdown: carriageReturns,
            selection: NSRange(location: 0, length: 5)
        ))
        #expect(divider.patch.replacement == "---\r")
        #expect(divider.patch.range == NSRange(location: 0, length: 6))

        let lineCommands: [(RectoEditorCommand, String)] = [
            (.heading(level: 1), "# "),
            (.bulletList, "- "),
            (.orderedList, "1. "),
            (.taskList, "- [ ] "),
            (.blockquote, "> "),
        ]
        for (command, prefix) in lineCommands {
            for indentation in 0...3 {
                let markdown = String(repeating: " ", count: indentation) + "keep me"
                let edit = try #require(RectoCommandTransformer.edit(
                    command: command,
                    markdown: markdown,
                    selection: NSRange(location: (markdown as NSString).length, length: 0)
                ))
                #expect(edit.patch.replacement == String(repeating: " ", count: indentation) + prefix + "keep me")
            }
            for markdown in ["    keep me", "\tkeep me", " \tkeep me"] {
                #expect(RectoCommandTransformer.edit(
                    command: command,
                    markdown: markdown,
                    selection: NSRange(location: (markdown as NSString).length, length: 0)
                ) == nil)
            }
        }
    }

    @Test("mounted line commands refuse indented code")
    func mountedLineCommandsRefuseIndentedCode() throws {
        for (commandIndex, command) in [
            RectoEditorCommand.heading(level: 1), .bulletList, .orderedList, .taskList, .blockquote,
        ].enumerated() {
            for (indentIndex, markdown) in ["    keep me", "\tkeep me"].enumerated() {
                let storage = RectoTextStorage(
                    documentId: "line-indent-\(commandIndex)-\(indentIndex)",
                    markdown: markdown
                )
                let controller = RectoWritingController()
                let harness = WindowHarness(
                    RectoEditorView(
                        storage: storage,
                        styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                        writingController: controller
                    )
                )
                let textView = try #require(harness.editorTextView)
                textView.setSelectedRange(NSRange(location: (markdown as NSString).length, length: 0))

                #expect(!controller.perform(command))
                #expect(textView.string == markdown)
                #expect(storage.markdown == markdown)
                harness.tearDown()
            }
        }
    }

    @Test("a heading keeps a collapsed caret at its content")
    func headingKeepsCaret() throws {
        let storage = RectoTextStorage(documentId: "heading-caret", markdown: "Hello")
        let controller = RectoWritingController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                writingController: controller
            ),
            size: CGSize(width: 640, height: 320)
        )
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        textView.setSelectedRange(NSRange(location: 5, length: 0))

        #expect(controller.perform(.heading(level: 1)))
        #expect(textView.string == "# Hello")
        #expect(textView.selectedRange() == NSRange(location: 7, length: 0))

        textView.insertText("!", replacementRange: textView.selectedRange())
        #expect(textView.string == "# Hello!")
    }

    @Test("a multiline partial selection survives prefix edits and CRLF")
    func multilineSelectionAndCRLF() throws {
        let markdown = "alpha 😀\r\n  - beta\r\n"
        let storage = RectoTextStorage(documentId: "multiline", markdown: markdown)
        let controller = RectoWritingController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                writingController: controller
            ),
            size: CGSize(width: 640, height: 320)
        )
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        let selection = (markdown as NSString).range(of: "pha 😀\r\n  - be")
        textView.setSelectedRange(selection)

        #expect(controller.perform(.orderedList))

        #expect(textView.string == "1. alpha 😀\r\n  1. beta\r\n")
        #expect((textView.string as NSString).substring(with: textView.selectedRange()) == "pha 😀\r\n  1. be")
    }

    @Test("nested list and blockquote containers keep their indentation")
    func nestedPrefixes() throws {
        let markdown = ">   - child\r\n  > 2. other\r\n"
        let task = try #require(RectoCommandTransformer.edit(
            command: .taskList,
            markdown: markdown,
            selection: NSRange(location: 0, length: (markdown as NSString).length)
        ))
        #expect(task.patch.replacement == ">   - [ ] child\r\n  > - [ ] other\r\n")

        let nestedHeading = ">   - [ ] child"
        let heading = try #require(RectoCommandTransformer.edit(
            command: .heading(level: 2),
            markdown: nestedHeading,
            selection: (nestedHeading as NSString).range(of: "child")
        ))
        #expect(heading.patch.replacement == ">   - [ ] ## child")

        let indented = "  - child"
        let quoted = try #require(RectoCommandTransformer.edit(
            command: .blockquote,
            markdown: indented,
            selection: NSRange(location: 4, length: 0)
        ))
        #expect(quoted.patch.replacement == "  > - child")
        #expect(quoted.selection == NSRange(location: 6, length: 0))

        let nestedQuote = "> > child\n>> sibling\n  > > third"
        let unquotedOnce = try #require(RectoCommandTransformer.edit(
            command: .blockquote,
            markdown: nestedQuote,
            selection: NSRange(location: 0, length: (nestedQuote as NSString).length)
        ))
        #expect(unquotedOnce.patch.replacement == "> child\n> sibling\n  > third")

        let mixedDepth = "> first\n> > second"
        let mixedEdit = try #require(RectoCommandTransformer.edit(
            command: .blockquote,
            markdown: mixedDepth,
            selection: NSRange(location: 0, length: (mixedDepth as NSString).length)
        ))
        #expect(mixedEdit.patch.replacement == "first\n> second")
    }

    @Test("link and image commands use host values")
    func hostValues() throws {
        let markdown = "Recto"
        let selection = NSRange(location: 0, length: 5)
        let link = try #require(RectoCommandTransformer.edit(
            command: .link(destination: "https://recto.example"),
            markdown: markdown,
            selection: selection
        ))
        #expect(link.patch.replacement == "[Recto](https://recto.example)")

        let image = try #require(RectoCommandTransformer.edit(
            command: .image(source: "image.png", alt: "Cover"),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ))
        #expect(image.patch.replacement == "![Cover](image.png)")
    }

    @Test("generated Markdown escapes hostile inline content")
    func hostileMarkdownContent() throws {
        let label = #"a]b\c[d"#
        let link = try #require(RectoCommandTransformer.edit(
            command: .link(destination: #"folder\name (final).md"#),
            markdown: label,
            selection: NSRange(location: 0, length: (label as NSString).length)
        ))
        #expect(link.patch.replacement == #"[a\]b\\c\[d](<folder\\name (final).md>)"#)

        let image = try #require(RectoCommandTransformer.edit(
            command: .image(source: "images/(draft)/cover.png", alt: #"cover] \ art"#),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ))
        #expect(image.patch.replacement == #"![cover\] \\ art](images/(draft)/cover.png)"#)

        for selected in ["a`b", "``edge``", "`both`"] {
            let edit = try #require(RectoCommandTransformer.edit(
                command: .inlineCode,
                markdown: selected,
                selection: NSRange(location: 0, length: (selected as NSString).length)
            ))
            let fenceLength = longestBacktickRun(in: selected) + 1
            let fence = String(repeating: "`", count: fenceLength)
            let padding = selected.hasPrefix("`") || selected.hasSuffix("`") ? " " : ""
            #expect(edit.patch.replacement == fence + padding + selected + padding + fence)
            #expect((edit.patch.replacement as NSString).substring(with: NSRange(
                location: edit.selection.location,
                length: edit.selection.length
            )) == selected)
            let toggled = try #require(RectoCommandTransformer.edit(
                command: .inlineCode,
                markdown: edit.patch.replacement,
                selection: edit.selection
            ))
            #expect(toggled.patch.replacement == selected)
        }

        let fencedBody = "before\n```\nafter"
        let fence = try #require(RectoCommandTransformer.edit(
            command: .codeBlock(language: "swift"),
            markdown: fencedBody,
            selection: NSRange(location: 0, length: (fencedBody as NSString).length)
        ))
        #expect(fence.patch.replacement == "````swift\nbefore\n```\nafter\n````")
        let trailingNewline = try #require(RectoCommandTransformer.edit(
            command: .codeBlock(language: "swift"),
            markdown: "line\n",
            selection: NSRange(location: 0, length: 5)
        ))
        #expect(trailingNewline.patch.replacement == "```swift\nline\n```")
        #expect((trailingNewline.patch.replacement as NSString).substring(with: trailingNewline.selection) == "line\n")
        #expect(RectoCommandTransformer.edit(
            command: .codeBlock(language: "swift\npython"),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .codeBlock(language: "\nswift"),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .codeBlock(language: "swift`unsafe"),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .codeBlock(language: String(repeating: "s", count: 101)),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
    }

    @Test("typed command inputs reject malformed or excessive values")
    func typedCommandLimits() {
        for identifier in ["note\nnext", "note\tindent", "note\u{0000}null", String(repeating: "n", count: 257)] {
            #expect(RectoCommandTransformer.edit(
                command: .footnote(identifier: identifier),
                markdown: "",
                selection: NSRange(location: 0, length: 0)
            ) == nil)
        }
        #expect(RectoCommandTransformer.edit(
            command: .table(rows: Int.max, columns: 2),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .table(rows: 2, columns: Int.max),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .link(destination: String(repeating: "x", count: 8_193)),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        #expect(RectoCommandTransformer.edit(
            command: .image(source: "image.png", alt: String(repeating: "a", count: 4_097)),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
        ) == nil)
        for alt in ["cover\n![injected]", "cover\tcaption", "cover\u{0000}caption"] {
            #expect(RectoCommandTransformer.edit(
                command: .image(source: "image.png", alt: alt),
                markdown: "",
                selection: NSRange(location: 0, length: 0)
            ) == nil)
        }
    }

    @Test("inline prose survives commands that generate blocks")
    func inlineProseSurvivesGeneratedBlocks() throws {
        let markdown = "before target after"
        let selected = (markdown as NSString).range(of: "target")

        let footnote = try #require(RectoCommandTransformer.edit(
            command: .footnote(identifier: "note"),
            markdown: markdown,
            selection: selected
        ))
        let footnoteResult = (markdown as NSString).replacingCharacters(
            in: footnote.patch.range,
            with: footnote.patch.replacement
        )
        #expect(footnoteResult == "before [^note] after\n\n[^note]: target")
        #expect((footnoteResult as NSString).substring(with: footnote.selection) == "target")

        let code = try #require(RectoCommandTransformer.edit(
            command: .codeBlock(language: "swift"),
            markdown: markdown,
            selection: selected
        ))
        let codeResult = (markdown as NSString).replacingCharacters(in: code.patch.range, with: code.patch.replacement)
        #expect(codeResult == "before \n\n```swift\ntarget\n```\n\n after")
        #expect((codeResult as NSString).substring(with: code.selection) == "target")

        let table = try #require(RectoCommandTransformer.edit(
            command: .table(rows: 2, columns: 2),
            markdown: markdown,
            selection: selected
        ))
        let tableResult = (markdown as NSString).replacingCharacters(in: table.patch.range, with: table.patch.replacement)
        #expect(tableResult == "before \n\n| Header | Header |\n| --- | --- |\n| Cell | Cell |\n\n after")
        #expect((tableResult as NSString).substring(with: table.selection) == "Header")
    }

    @Test("mounted block commands preserve surrounding inline prose")
    func mountedBlockCommandsPreserveInlineProse() throws {
        let cases: [(RectoEditorCommand, String, String)] = [
            (.codeBlock(language: "swift"), "before \n\n```swift\ntarget\n```\n\n after", "target"),
            (
                .table(rows: 2, columns: 2),
                "before \n\n| Header | Header |\n| --- | --- |\n| Cell | Cell |\n\n after",
                "Header"
            ),
            (.footnote(identifier: "note"), "before [^note] after\n\n[^note]: target", "target"),
        ]
        for (index, item) in cases.enumerated() {
            let markdown = "before target after"
            let storage = RectoTextStorage(documentId: "inline-block-\(index)", markdown: markdown)
            let controller = RectoWritingController()
            let harness = WindowHarness(
                RectoEditorView(
                    storage: storage,
                    styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                    writingController: controller
                )
            )
            let textView = try #require(harness.editorTextView)
            textView.setSelectedRange((markdown as NSString).range(of: "target"))

            #expect(controller.perform(item.0))
            #expect(textView.string == item.1)
            #expect((textView.string as NSString).substring(with: textView.selectedRange()) == item.2)
            harness.tearDown()
        }
    }

    @Test("mounted generated blocks keep exact selections in CRLF documents")
    func generatedBlocksKeepCRLFSelections() throws {
        let commands: [(RectoEditorCommand, String)] = [
            (.codeBlock(language: "swift"), "code"),
            (.table(rows: 2, columns: 2), "Header"),
            (.footnote(identifier: "note"), "Footnote text"),
        ]
        for (index, item) in commands.enumerated() {
            let markdown = "before\r\n\r\nafter"
            let storage = RectoTextStorage(documentId: "crlf-command-\(index)", markdown: markdown)
            let controller = RectoWritingController()
            let harness = WindowHarness(
                RectoEditorView(
                    storage: storage,
                    styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                    writingController: controller
                )
            )
            let textView = try #require(harness.editorTextView)
            textView.setSelectedRange(NSRange(location: 8, length: 0))

            #expect(controller.perform(item.0))
            #expect((textView.string as NSString).substring(with: textView.selectedRange()) == item.1)
            #expect(textView.selectedRange() == (textView.string as NSString).range(of: item.1))
            harness.tearDown()
        }

        let slashMarkdown = "before\r\n/tab\r\nafter"
        let slashStorage = RectoTextStorage(documentId: "crlf-slash", markdown: slashMarkdown)
        let slashController = RectoWritingController()
        let slashHarness = WindowHarness(
            RectoEditorView(
                storage: slashStorage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                writingController: slashController
            )
        )
        defer { slashHarness.tearDown() }
        let slashTextView = try #require(slashHarness.editorTextView)
        slashTextView.setSelectedRange(NSRange(location: 12, length: 0))

        #expect(slashController.selectSlashEntry(id: "table"))
        #expect((slashTextView.string as NSString).substring(with: slashTextView.selectedRange()) == "Header")
        #expect(slashTextView.selectedRange() == (slashTextView.string as NSString).range(of: "Header"))
    }

    @Test("slash opens only at a source-line command position")
    func slashCommandPosition() throws {
        for indentation in 0...3 {
            let valid = String(repeating: " ", count: indentation) + "/hea"
            let state = try #require(RectoSlashMenu.state(
                markdown: valid,
                selection: NSRange(location: (valid as NSString).length, length: 0),
                selectedIndex: 0,
                anchorRect: nil
            ))
            #expect(state.query == "hea")
            #expect(state.entries.map(\.id) == ["h1", "h2", "h3"])
            #expect(state.queryRange == NSRange(location: indentation, length: 4))
        }

        for invalid in ["word /hea", "    /hea", "\t/hea", " \t/hea"] {
            #expect(RectoSlashMenu.state(
                markdown: invalid,
                selection: NSRange(location: (invalid as NSString).length, length: 0),
                selectedIndex: 0,
                anchorRect: nil
            ) == nil)
        }

        let noMatch = "/definitely-no-command"
        #expect(RectoSlashMenu.state(
            markdown: noMatch,
            selection: NSRange(location: (noMatch as NSString).length, length: 0),
            selectedIndex: 0,
            anchorRect: nil
        ) == nil)
    }

    @Test("mounted slash headings keep valid CommonMark indentation")
    func mountedSlashHeadingIndentation() throws {
        for indentation in 0...3 {
            let spaces = String(repeating: " ", count: indentation)
            let markdown = spaces + "/h1"
            let storage = RectoTextStorage(documentId: "slash-indent-\(indentation)", markdown: markdown)
            let controller = RectoWritingController()
            let harness = WindowHarness(
                RectoEditorView(
                    storage: storage,
                    styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                    writingController: controller
                )
            )
            let textView = try #require(harness.editorTextView)
            textView.setSelectedRange(NSRange(location: (markdown as NSString).length, length: 0))

            #expect(controller.selectSlashEntry(id: "h1"))
            #expect(textView.string == spaces + "# ")
            #expect(textView.selectedRange() == NSRange(location: indentation + 2, length: 0))
            harness.tearDown()
        }

        for (index, markdown) in ["    /h1", "\t/h1"].enumerated() {
            let storage = RectoTextStorage(documentId: "slash-reject-\(index)", markdown: markdown)
            let controller = RectoWritingController()
            let harness = WindowHarness(
                RectoEditorView(
                    storage: storage,
                    styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                    writingController: controller
                )
            )
            let textView = try #require(harness.editorTextView)
            textView.setSelectedRange(NSRange(location: (markdown as NSString).length, length: 0))

            #expect(controller.slashMenuState == nil)
            #expect(!controller.selectSlashEntry(id: "h1"))
            #expect(textView.string == markdown)
            harness.tearDown()
        }
    }

    @Test("structural commands preserve retained mixed line endings")
    func structuralCommandsPreserveMixedLineEndings() throws {
        let markdown = "first\r\nsecond\nthird"
        let storage = RectoTextStorage(documentId: "mixed-line-endings", markdown: markdown)
        let controller = RectoWritingController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                writingController: controller
            )
        )
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        textView.setSelectedRange(NSRange(location: 0, length: (markdown as NSString).length))

        #expect(controller.perform(.bulletList))
        #expect(textView.string == "- first\r\n- second\n- third")
        #expect(storage.markdown == textView.string)
    }

    @Test("slash entries match the generated web fixture")
    func slashFixtureParity() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let url = root.appending(path: "packages/editor-fixtures/slash-entries.json")
        let fixture = try JSONDecoder().decode(SlashFixture.self, from: Data(contentsOf: url))

        #expect(fixture.clearCurrentBlock)
        #expect(fixture.entries.map(\.id) == RectoSlashMenu.entries.map(\.id))
        #expect(fixture.entries.map(\.label) == RectoSlashMenu.entries.map(\.label))
        #expect(fixture.entries.map(\.aliases) == RectoSlashMenu.entries.map(\.aliases))
        #expect(fixture.entries.map(\.insertion.fixtureValue) == RectoSlashMenu.entries.map(\.insertion.fixtureValue))
    }

    @Test("a mounted command publishes one structural edit")
    func mountedCommandIsStructural() throws {
        let storage = RectoTextStorage(documentId: "writing", markdown: "Recto")
        let controller = RectoWritingController()
        var edits: [RectoEditorEdit] = []
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight, undo: .external),
                onEdit: { edits.append($0) },
                writingController: controller
            ),
            size: CGSize(width: 640, height: 320)
        )
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        #expect(controller.perform(.bold))

        #expect(storage.markdown == "**Recto**")
        #expect(edits == [RectoEditorEdit(markdown: "**Recto**", structural: true)])
        #expect(textView.selectedRange() == NSRange(location: 2, length: 5))
    }
}

private func longestBacktickRun(in value: String) -> Int {
    var current = 0
    var longest = 0
    for character in value {
        current = character == "`" ? current + 1 : 0
        longest = max(longest, current)
    }
    return longest
}

private extension RectoSlashInsertion {
    var fixtureValue: String {
        switch self {
        case let .heading(level): "heading|\(level)"
        case let .text(text): "text|\(text)"
        case .bulletList: "wrap|bullet-list|list-item"
        case .orderedList: "wrap|ordered-list|list-item"
        case .blockquote: "wrap|blockquote|paragraph"
        case let .codeBlock(language): "code-block|\(language)"
        case .divider: "divider"
        case let .table(rows, columns): "table|\(rows)|\(columns)"
        }
    }
}

private extension SlashFixture.Entry.Insertion {
    var fixtureValue: String {
        switch kind {
        case "heading": "heading|\(level ?? -1)"
        case "text": "text|\(text ?? "")"
        case "wrap": "wrap|\(block ?? "")|\(inner ?? "")"
        case "code-block": "code-block|\(language ?? "")"
        case "divider": "divider"
        case "table": "table|\(rows ?? -1)|\(columns ?? -1)"
        default: kind
        }
    }
}
