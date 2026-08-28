import Foundation

struct DifferentialDocument {
    let name: String
    let markdown: String
    let isMutated: Bool

    init(name: String, markdown: String, isMutated: Bool = false) {
        self.name = name
        self.markdown = markdown
        self.isMutated = isMutated
    }
}

enum MarkdownDifferentialGenerator {
    static let seed: UInt64 = 0x5EED_C0DE_2026_0828
    static let documentCount = 384
    static let mutatedDocumentCount = documentCount / 4
    static let maximumDocumentCharacters = 2_048

    static func documents(unicodeCases: [CorpusCase]) -> [DifferentialDocument] {
        var documents = coverageDocuments
        documents.append(
            contentsOf: unicodeCases.map {
                DifferentialDocument(name: "unicode fixture \($0.id): \($0.name)", markdown: $0.input)
            })

        var random = SplitMix64(seed: seed)
        let unicodeFragments = unicodeCases.map(\.input)
        while documents.count < documentCount {
            let documentIndex = documents.count
            let blockCount = 2 + random.index(upperBound: 6)
            var blocks: [String] = []

            if documentIndex.isMultiple(of: 13) {
                blocks.append("---\ntitle: Generated \(documentIndex)\ntags: [swift, markdown]\n---")
            }

            for _ in 0..<blockCount {
                if random.index(upperBound: 3) == 0 {
                    blocks.append(paragraph(using: &random))
                } else {
                    let bank = blockFragments + unicodeFragments
                    blocks.append(bank[random.index(upperBound: bank.count)])
                }
            }

            var markdown = blocks.joined(separator: "\n\n") + "\n"
            if documentIndex.isMultiple(of: 11) {
                markdown = markdown.replacingOccurrences(of: "\n", with: "\r\n")
            } else if documentIndex.isMultiple(of: 17) {
                markdown = markdown.replacingOccurrences(of: "\n", with: "\r")
            }
            markdown = String(markdown.prefix(maximumDocumentCharacters))
            documents.append(
                DifferentialDocument(name: "seeded \(documentIndex)", markdown: markdown))
        }
        return applyingMutations(to: documents)
    }

    /// Every mutation kind runs twice under LF, CRLF, and lone CR. Keeping the
    /// share fixed makes coverage changes visible instead of depending on random
    /// selection luck.
    private static func applyingMutations(
        to documents: [DifferentialDocument]
    ) -> [DifferentialDocument] {
        let kinds = NearMissMutation.allCases
        let lineEndings = [(name: "LF", value: "\n"), (name: "CRLF", value: "\r\n"),
            (name: "CR", value: "\r")]
        let stride = documentCount / mutatedDocumentCount
        let offset = Int(seed % UInt64(stride))

        return documents.enumerated().map { index, document in
            guard index % stride == offset else { return document }
            let ordinal = index / stride
            let kind = kinds[ordinal % kinds.count]
            let lineEnding = lineEndings[(ordinal / kinds.count) % lineEndings.count]
            let fragment = kind.corruptedFragment.replacingOccurrences(
                of: "\n", with: lineEnding.value)
            let separator = lineEnding.value + lineEnding.value
            let baseLimit = max(0, maximumDocumentCharacters - separator.count - fragment.count)
            let base = String(document.markdown.prefix(baseLimit))
            return DifferentialDocument(
                name: "mutated \(kind.name), \(lineEnding.name), from \(document.name)",
                markdown: base + separator + fragment,
                isMutated: true)
        }
    }

    private static func paragraph(using random: inout SplitMix64) -> String {
        let fragmentCount = 2 + random.index(upperBound: 5)
        return (0..<fragmentCount).map { _ in
            inlineFragments[random.index(upperBound: inlineFragments.count)]
        }.joined(separator: " ")
    }

    private static let coverageDocuments: [DifferentialDocument] = [
        DifferentialDocument(
            name: "ATX depths and closing hashes",
            markdown: "# One #\n## Two ##\n### Three ###\n#### Four ####\n##### Five #####\n###### Six ######\n"
        ),
        DifferentialDocument(
            name: "setext headings",
            markdown: "Primary *heading*\n=================\n\nSecondary `heading`\n-------------------\n"
        ),
        DifferentialDocument(
            name: "soft and hard breaks",
            markdown: "soft one\nsoft two\n\nhard spaces  \nafter spaces\n\nhard slash\\\nafter slash\n"
        ),
        DifferentialDocument(
            name: "fenced and indented code",
            markdown: "```swift\nlet hidden = true\n```\n\n~~~\nalso hidden\n~~~\n\n    indented hidden\n\nVisible prose.\n"
        ),
        DifferentialDocument(
            name: "HTML block types",
            markdown: "<script>hidden one</script>\n\n<!-- hidden two -->\n\n<?php hidden three ?>\n\n<!DOCTYPE hidden four>\n\n<![CDATA[ hidden five ]]>\n\n<div>\nhidden six\n</div>\n\n<x-recto>\nhidden seven\n</x-recto>\n\nVisible.\n"
        ),
        DifferentialDocument(
            name: "nested blockquotes",
            markdown: "> outer prose\n> > inner prose\n> > > ### Deep heading\n> lazy continuation\n"
        ),
        DifferentialDocument(
            name: "lists and continuations",
            markdown: "- bullet first\n  continuation line\n- bullet second\n\n1. ordered first\n   continuation line\n2. ordered second\n\n- [ ] open task\n- [x] closed task\n"
        ),
        DifferentialDocument(
            name: "ordered paragraph interrupts",
            markdown: "alpha\n2. still paragraph\n\nalpha\n1. list item\n\nalpha\n1.   \n"
        ),
        DifferentialDocument(
            name: "GFM table",
            markdown: "| left | right |\n| :--- | ---: |\n| escaped \\| pipe | `inline | code` |\n"
        ),
        DifferentialDocument(
            name: "footnotes",
            markdown: "Body[^note] and missing[^gone].\n\n[^note]: Footnote prose with *emphasis*.\n    Continued note.\n"
        ),
        DifferentialDocument(
            name: "link references",
            markdown: "[full][defined] [collapsed][] [defined] [missing][gone] [orphan]\n\n[defined]: https://example.com \"Title\"\n[collapsed]: /collapsed\n"
        ),
        DifferentialDocument(
            name: "image references",
            markdown: "![inline](image.png) ![full][image] ![image][] ![image] ![missing][gone] ![missing]\n\n[image]: /image.png\n"
        ),
        DifferentialDocument(
            name: "inline constructs",
            markdown: "[inline link](https://example.com) ![alt](image.png) <https://example.com> <me@example.com> <span>raw</span> `code span` prose\n"
        ),
        DifferentialDocument(
            name: "delimiter flanking",
            markdown: "*emphasis* **strong** _emphasis_ __strong__ foo_bar_baz un*frigging*believable _(edge)_ 2 * 3 ~~gone~~ ~kept~\n"
        ),
        DifferentialDocument(
            name: "character references",
            markdown: "# A &amp; B &#38; C &#x26; D &copy; E &nbsp; F &bogus;\n"
        ),
        DifferentialDocument(
            name: "closed frontmatter",
            markdown: "---\ntitle: Hidden words\nsubtitle: Also hidden\n---\n\n# Visible heading\n"
        ),
        DifferentialDocument(
            name: "unclosed frontmatter",
            markdown: "---\ntitle: Ordinary prose\n# Visible heading\n"
        ),
        DifferentialDocument(
            name: "thematic breaks",
            markdown: "Before\n\n***\n\nMiddle\n\n___\n\nLater\n\n- - -\n\nAfter\n"
        ),
        DifferentialDocument(
            name: "CRLF",
            markdown: "# CRLF heading\r\n\r\nBody one.\r\n\r\n- item\r\n"
        ),
        DifferentialDocument(
            name: "lone CR",
            markdown: "# CR heading\r\rBody one.\r\r- item\r"
        ),
        DifferentialDocument(
            name: "NBSP and ZWSP",
            markdown: "one\u{00A0}two three\u{200B}four five\n"
        ),
        DifferentialDocument(
            name: "definition-looking fenced code",
            markdown: "```\n[inside]: /not-a-definition\n```\n\n![alt][inside] [text][inside]\n"
        ),
    ]

    private static let blockFragments: [String] = [
        "Plain paragraph with ordinary words.",
        "# ATX heading",
        "## ATX heading ##",
        "Setext heading\n==============",
        "Setext subheading\n-----------------",
        "First soft line\nsecond soft line",
        "First hard line  \nsecond hard line",
        "```js\nconst hidden = 1\n```",
        "~~~text\nhidden fenced prose\n~~~",
        "    hidden indented prose",
        "<!-- hidden comment prose -->",
        "<?worker hidden processing prose ?>",
        "<!DOCTYPE hidden declaration prose>",
        "<![CDATA[ hidden cdata prose ]]>",
        "<section>\nhidden block prose\n</section>",
        "> quote prose\n> > nested quote prose",
        "- bullet one\n  continuation prose\n- bullet two",
        "1. ordered one\n   continuation prose\n2. ordered two",
        "- [ ] task open\n- [x] task done",
        "| A | B |\n| - | - |\n| escaped \\| pipe | `code` |",
        "Body[^n] prose.\n\n[^n]: Note prose.",
        "[defined link][ref] [missing link][none]\n\n[ref]: https://example.com",
        "![defined image][img] ![missing image][none]\n\n[img]: /image.png",
        "***",
        "___",
        "- - -",
    ]

    private static let inlineFragments: [String] = [
        "plain prose",
        "[inline link](https://example.com/path)",
        "![inline image](image.png)",
        "<https://example.com>",
        "<person@example.com>",
        "<span>raw HTML</span>",
        "`inline code`",
        "*star emphasis*",
        "**star strong**",
        "_underscore emphasis_",
        "__underscore strong__",
        "foo_bar_baz",
        "un*frigging*believable",
        "_(flanking punctuation)_",
        "~~struck prose~~",
        "&amp; &#38; &#x26; &copy; &nbsp;",
        "NBSP\u{00A0}split ZWSP\u{200B}joined",
        "👨‍👩‍👧‍👦 🇿🇦 👋🏽 👋",
    ]
}

private enum NearMissMutation: Int, CaseIterable {
    case linkDestinationSpace
    case linkTitleSpace
    case missingInlineLinkClose
    case missingReferenceClose
    case missingCodeSpanClose
    case missingFenceClose
    case undefinedReference
    case normalizedDefinedReference
    case entityInHeading
    case entityInTableCell
    case entityInLinkText
    case entityInCodeSpan
    case unterminatedHTMLComment
    case unterminatedScript
    case listFenceWrongIndent
    case nonOneOrderedListAfterParagraph

    var name: String {
        switch self {
        case .linkDestinationSpace: "space in link destination"
        case .linkTitleSpace: "space in link title"
        case .missingInlineLinkClose: "missing link parenthesis"
        case .missingReferenceClose: "missing reference bracket"
        case .missingCodeSpanClose: "missing code span backtick"
        case .missingFenceClose: "missing fence"
        case .undefinedReference: "undefined reference"
        case .normalizedDefinedReference: "normalized defined reference"
        case .entityInHeading: "entity in heading"
        case .entityInTableCell: "entity in table cell"
        case .entityInLinkText: "entity in link text"
        case .entityInCodeSpan: "entity in code span"
        case .unterminatedHTMLComment: "unterminated HTML comment"
        case .unterminatedScript: "unterminated script"
        case .listFenceWrongIndent: "list fence wrong indent"
        case .nonOneOrderedListAfterParagraph: "non-one ordered list after paragraph"
        }
    }

    var corruptedFragment: String {
        switch self {
        case .linkDestinationSpace:
            return "a[foo](barbaz)b\n".replacingOccurrences(of: "barbaz", with: "bar baz")
        case .linkTitleSpace:
            return "a[foo](bar \"title\")b\n".replacingOccurrences(
                of: "title", with: "title space")
        case .missingInlineLinkClose:
            return "a[foo](bar)b\n".replacingOccurrences(of: ")b", with: "b")
        case .missingReferenceClose:
            return "a[foo][ref]b\n\n[ref]: /url\n".replacingOccurrences(
                of: "[ref]b", with: "[refb")
        case .missingCodeSpanClose:
            return "a `code` b\n".replacingOccurrences(of: "` b", with: " b")
        case .missingFenceClose:
            return "```\nhidden prose\n```\nafter\n".replacingOccurrences(
                of: "\n```\nafter", with: "\nafter")
        case .undefinedReference:
            return "a[foo][ref]b\n\n[ref]: /url\n".replacingOccurrences(
                of: "\n\n[ref]: /url", with: "")
        case .normalizedDefinedReference:
            return "a[foo bar][foo bar]b\n\n[foo bar]: /url\n".replacingOccurrences(
                of: "[foo bar]b", with: "[ FOO \t BAR ]b")
        case .entityInHeading:
            return "# one two\n".replacingOccurrences(of: "one two", with: "one&emsp;two")
        case .entityInTableCell:
            return "| value |\n| - |\n| one two |\n".replacingOccurrences(
                of: "one two", with: "one&emsp;two")
        case .entityInLinkText:
            return "[one two](/url)\n".replacingOccurrences(
                of: "one two", with: "one&emsp;two")
        case .entityInCodeSpan:
            return "`one two`\n".replacingOccurrences(of: "one two", with: "one&emsp;two")
        case .unterminatedHTMLComment:
            return "<!-- hidden prose -->\nafter\n".replacingOccurrences(of: " -->", with: "")
        case .unterminatedScript:
            return "<script>hidden prose</script>\nafter\n".replacingOccurrences(
                of: "</script>", with: "")
        case .listFenceWrongIndent:
            return "- item\n  ```\n  hidden prose\n  ```\n- after\n".replacingOccurrences(
                of: "\n  ```\n- after", with: "\n ```\n- after")
        case .nonOneOrderedListAfterParagraph:
            return "paragraph\n1. list item\n".replacingOccurrences(
                of: "\n1.", with: "\n2.")
        }
    }
}

/// Swift has no seeded random generator. SplitMix64 is small, deterministic,
/// and sufficient here because the output selects fixtures rather than secrets.
private struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func index(upperBound: Int) -> Int {
        precondition(upperBound > 0)
        return Int(next() % UInt64(upperBound))
    }

    private mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }
}
