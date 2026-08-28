import Foundation

extension MarkdownProse {
    /// Coordinates the block and inline scans that reproduce the contract on
    /// `MarkdownProse`. One UTF-16 buffer backs every nested scan so heading
    /// offsets remain absolute offsets into the original markdown.
    struct Walker {
        private let source: [UInt16]
        private let lines: [SourceLine]

        init(markdown: String) {
            source = Array(markdown.utf16)
            lines = Self.splitLines(source)
        }

        func run() -> (prose: String, headings: [OutlineHeading]) {
            var scanner = BlockScanner(
                source: source, lines: lines,
                definitionLabels: Self.definitionLabels(source, lines))
            let result = scanner.run(allowsFrontmatter: true)
            return (
                String(decoding: result.prose, as: UTF16.self),
                result.headings
            )
        }

        /// Splits physical lines without losing their original line endings.
        /// `\r\n` is one line ending but two UTF-16 units, and every offset this
        /// walker emits is a UTF-16 offset into the original string.
        /// Every link-reference label the document defines, normalised.
        ///
        /// A bare `[label]` is a `linkReference` node — whose child text is
        /// prose — only when a matching definition exists somewhere in the
        /// document; otherwise remark leaves the brackets as literal text, and
        /// `foo[bar]baz` is one word rather than three. Definitions resolve
        /// document-wide and in any order, so this has to be a pre-pass.
        ///
        /// Recognising the shape line by line rather than only at block starts
        /// can over-collect (a `[x]: y` inside a fenced code block), which at
        /// worst turns a bare `[x]` elsewhere into a link. That direction is
        /// harmless: a link's text is prose either way, and only the bracket
        /// characters differ.
        private static func definitionLabels(_ source: [UInt16], _ lines: [SourceLine])
            -> Set<String>
        {
            var labels: Set<String> = []
            for line in lines {
                var cursor = line.contentStart
                var indent = 0
                while cursor < line.end, indent < 4,
                    source[cursor] == ASCII.space || source[cursor] == ASCII.tab
                {
                    cursor += 1
                    indent += 1
                }
                guard cursor < line.end, source[cursor] == ASCII.leftBracket,
                    cursor + 1 < line.end, source[cursor + 1] != ASCII.caret
                else { continue }
                cursor += 1
                let labelStart = cursor
                while cursor < line.end, source[cursor] != ASCII.rightBracket { cursor += 1 }
                guard cursor > labelStart, cursor + 1 < line.end,
                    source[cursor + 1] == ASCII.colon
                else { continue }
                labels.insert(normalizedLabel(source[labelStart..<cursor]))
            }
            return labels
        }

        /// CommonMark matches labels case-insensitively with whitespace
        /// collapsed, so `[Foo  Bar]` and `[foo bar]` are the same label.
        static func normalizedLabel(_ units: ArraySlice<UInt16>) -> String {
            String(decoding: units, as: UTF16.self)
                .split(whereSeparator: { $0.isWhitespace })
                .joined(separator: " ")
                .lowercased()
        }

        private static func splitLines(_ source: [UInt16]) -> [SourceLine] {
            var result: [SourceLine] = []
            var start = 0
            var cursor = 0

            while cursor < source.count {
                if source[cursor] == ASCII.lineFeed || source[cursor] == ASCII.carriageReturn {
                    let endingStart = cursor
                    if source[cursor] == ASCII.carriageReturn,
                        cursor + 1 < source.count, source[cursor + 1] == ASCII.lineFeed
                    {
                        cursor += 2
                    } else {
                        cursor += 1
                    }
                    result.append(
                        SourceLine(
                            start: start, contentStart: start, end: endingStart,
                            endingEnd: cursor))
                    start = cursor
                } else {
                    cursor += 1
                }
            }

            if start < source.count {
                result.append(
                    SourceLine(
                        start: start, contentStart: start, end: source.count,
                        endingEnd: source.count))
            }
            return result
        }
    }
}

/// ASCII syntax bytes expressed as UTF-16 code units. `Character` comparisons
/// would pass through grapheme breaking, while this scanner must compare syntax
/// in the same coordinate system as the offsets it returns.
private enum ASCII {
    static let tab: UInt16 = 0x09
    static let lineFeed: UInt16 = 0x0A
    static let carriageReturn: UInt16 = 0x0D
    static let space: UInt16 = 0x20
    static let exclamation: UInt16 = 0x21
    static let quote: UInt16 = 0x22
    static let hash: UInt16 = 0x23
    static let apostrophe: UInt16 = 0x27
    static let leftParenthesis: UInt16 = 0x28
    static let rightParenthesis: UInt16 = 0x29
    static let asterisk: UInt16 = 0x2A
    static let plus: UInt16 = 0x2B
    static let hyphen: UInt16 = 0x2D
    static let period: UInt16 = 0x2E
    static let slash: UInt16 = 0x2F
    static let zero: UInt16 = 0x30
    static let nine: UInt16 = 0x39
    static let colon: UInt16 = 0x3A
    static let lessThan: UInt16 = 0x3C
    static let equals: UInt16 = 0x3D
    static let greaterThan: UInt16 = 0x3E
    static let at: UInt16 = 0x40
    static let leftBracket: UInt16 = 0x5B
    static let backslash: UInt16 = 0x5C
    static let rightBracket: UInt16 = 0x5D
    static let caret: UInt16 = 0x5E
    static let underscore: UInt16 = 0x5F
    static let backtick: UInt16 = 0x60
    static let pipe: UInt16 = 0x7C
    static let tilde: UInt16 = 0x7E
}

/// One physical source line, with absolute UTF-16 boundaries into the document.
///
/// `start` is the first unit of the physical line. `contentStart` is the first
/// unit visible to the current block scanner. Nested blockquotes and list items
/// move it past their markers while retaining the original absolute offsets.
/// `end` excludes the line ending. `endingEnd` includes it, so a CRLF ending
/// spans two units between `end` and `endingEnd`.
private struct SourceLine {
    let start: Int
    let contentStart: Int
    let end: Int
    let endingEnd: Int

    func replacingContentStart(with contentStart: Int) -> SourceLine {
        SourceLine(
            start: start, contentStart: min(contentStart, end), end: end,
            endingEnd: endingEnd)
    }
}

/// Block-level output. `prose` follows the MDAST text-node contract, while each
/// heading has already been flattened under the separate outline contract.
private struct BlockResult {
    var prose: [UInt16] = []
    var headings: [OutlineHeading] = []
}

/// The two views of one inline sequence required by the JavaScript behavior.
///
/// `prose` contains only MDAST `text` node values because `countWords` visits
/// only those nodes. `flattened` also contains values from code spans and raw
/// HTML because `lib/outline/extract.ts` accepts any heading child with a
/// `value`. `Token.value` is the branch where those views diverge.
private struct InlineResult {
    var prose: [UInt16]
    var flattened: [UInt16]
}

/// Recognises block structure, delegates leaf content to `InlineScanner`, and
/// keeps heading offsets anchored to the original source. The scanner only
/// implements the markdown subset described on `MarkdownProse`.
private struct BlockScanner {
    let source: [UInt16]
    let lines: [SourceLine]
    /// Document-wide, so a nested scanner resolves a definition that appears
    /// outside the blockquote or list item it is scanning.
    let definitionLabels: Set<String>

    /// CommonMark's tag names for HTML block type 6. These tags consume through
    /// the next blank line rather than becoming inline HTML inside a paragraph.
    private static let blockTags: Set<String> = [
        "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption",
        "center", "col", "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt",
        "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2",
        "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe", "legend", "li",
        "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
        "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
        "title", "tr", "track", "ul",
    ]

    /// Scans blocks in precedence order — the order *is* part of the parse.
    ///
    /// Only the root walker enables frontmatter: remark-frontmatter recognises a
    /// fence at the document's first line and nowhere else, and there it has to
    /// win over the thematic-break shape `---`.
    ///
    /// Two other orderings are load-bearing. Thematic breaks are tested before
    /// list items, because `- - -` and `* * *` match both and CommonMark gives
    /// the break precedence — testing lists first turned `- - -` into three
    /// items and swallowed the setext heading after it. And tables are
    /// recognised before paragraphs, because a single-cell `---` delimiter row
    /// also looks like a setext underline.
    mutating func run(allowsFrontmatter: Bool = false) -> BlockResult {
        var result = BlockResult()
        var lineIndex = 0

        if allowsFrontmatter, lines.first.map({ exactText($0, "---") }) == true {
            lineIndex = 1
            while lineIndex < lines.count {
                if exactText(lines[lineIndex], "---") || exactText(lines[lineIndex], "...") {
                    lineIndex += 1
                    break
                }
                lineIndex += 1
            }
            result.prose.append(ASCII.space)
        }

        while lineIndex < lines.count {
            let line = lines[lineIndex]
            if isBlank(line) {
                result.prose.append(ASCII.space)
                lineIndex += 1
                continue
            }

            if let quoteStart = blockquoteContentStart(line) {
                let consumed = consumeBlockquote(from: lineIndex, firstContentStart: quoteStart)
                appendNested(consumed.result, markerCount: consumed.markers, to: &result)
                lineIndex = consumed.nextIndex
                continue
            }

            // Before lists, because `- - -` and `* * *` match both and
            // CommonMark gives the thematic break precedence.
            if isThematicBreak(line) {
                result.prose.append(ASCII.space)
                lineIndex += 1
                continue
            }

            if let item = listItem(in: line) {
                let consumed = consumeListItem(from: lineIndex, item: item)
                appendNested(consumed.result, markerCount: consumed.markers, to: &result)
                lineIndex = consumed.nextIndex
                continue
            }

            if let fence = openingFence(in: line) {
                result.prose.append(ASCII.space)
                lineIndex += 1
                while lineIndex < lines.count {
                    let closes = closingFence(lines[lineIndex], fence: fence)
                    lineIndex += 1
                    if closes { break }
                }
                continue
            }

            if let html = htmlBlockStart(line) {
                result.prose.append(ASCII.space)
                lineIndex = consumeHTMLBlock(from: lineIndex, kind: html)
                continue
            }

            if let heading = atxHeading(in: line) {
                let inline = InlineScanner(
                    units: Array(slice(heading.contentStart..<heading.contentEnd)),
                    definitionLabels: definitionLabels
                ).run()
                result.prose.append(ASCII.space)
                result.prose.append(contentsOf: inline.prose)
                if heading.hasClosingSequence { result.prose.append(ASCII.space) }
                result.headings.append(
                    OutlineHeading(
                        depth: heading.depth,
                        text: trimJSWhitespace(String(decoding: inline.flattened, as: UTF16.self)),
                        offset: heading.offset,
                        index: result.headings.count))
                lineIndex += 1
                continue
            }

            if lineIndex + 1 < lines.count, hasUnescapedPipe(line),
                isTableDelimiter(lines[lineIndex + 1])
            {
                lineIndex = consumeTable(from: lineIndex, into: &result)
                continue
            }

            if let contentStart = footnoteDefinitionContentStart(line) {
                let consumed = consumeFootnote(from: lineIndex, contentStart: contentStart)
                result.prose.append(ASCII.space)
                result.prose.append(contentsOf: inlineContent(consumed.lines).prose)
                lineIndex = consumed.nextIndex
                continue
            }

            if let definitionEnd = linkReferenceDefinitionEnd(from: lineIndex) {
                result.prose.append(ASCII.space)
                lineIndex = definitionEnd
                continue
            }

            // CommonMark reserves four columns of indentation for an indented
            // code block, whose contents do not create MDAST text nodes.
            if indentation(of: line).columns >= 4 {
                result.prose.append(ASCII.space)
                lineIndex += 1
                while lineIndex < lines.count {
                    if isBlank(lines[lineIndex]) || indentation(of: lines[lineIndex]).columns >= 4 {
                        lineIndex += 1
                    } else {
                        break
                    }
                }
                continue
            }

            lineIndex = consumeParagraph(from: lineIndex, into: &result)
        }

        return result
    }

    /// Restores one separator for each source line whose quote, list, or task
    /// marker was stripped. Those markers become non-text MDAST structure;
    /// omitting their spaces can merge text that JavaScript's text-node join
    /// keeps apart.
    private func appendNested(_ nested: BlockResult, markerCount: Int, to result: inout BlockResult) {
        result.prose.append(contentsOf: repeatElement(ASCII.space, count: markerCount))
        result.prose.append(contentsOf: nested.prose)
        for heading in nested.headings {
            result.headings.append(
                OutlineHeading(
                    depth: heading.depth, text: heading.text, offset: heading.offset,
                    index: result.headings.count))
        }
    }

    /// Builds a nested view of a blockquote without rebasing source offsets.
    /// CommonMark permits non-blank lazy continuation lines without a `>` as
    /// long as no new block interrupts the quote.
    private func consumeBlockquote(
        from startIndex: Int, firstContentStart: Int
    ) -> (result: BlockResult, nextIndex: Int, markers: Int) {
        var nestedLines: [SourceLine] = [
            lines[startIndex].replacingContentStart(with: firstContentStart)
        ]
        var markerCount = 1
        var cursor = startIndex + 1

        while cursor < lines.count {
            let line = lines[cursor]
            if let contentStart = blockquoteContentStart(line) {
                nestedLines.append(line.replacingContentStart(with: contentStart))
                markerCount += 1
                cursor += 1
            } else if !isBlank(line), !startsInterruptingBlock(line) {
                nestedLines.append(line)
                cursor += 1
            } else {
                break
            }
        }

        var scanner = BlockScanner(source: source, lines: nestedLines, definitionLabels: definitionLabels)
        return (scanner.run(), cursor, markerCount)
    }

    /// Builds the lines owned by one list item, including lazy continuation.
    /// After a blank line, an unindented line starts a new block rather than
    /// continuing lazily, so `sawBlank` ends the item at that boundary.
    private func consumeListItem(
        from startIndex: Int, item: ListItem
    ) -> (result: BlockResult, nextIndex: Int, markers: Int) {
        var nestedLines = [lines[startIndex].replacingContentStart(with: item.contentStart)]
        var cursor = startIndex + 1
        var sawBlank = false

        while cursor < lines.count {
            let line = lines[cursor]
            if isBlank(line) {
                nestedLines.append(line)
                sawBlank = true
                cursor += 1
                continue
            }

            let indent = indentation(of: line)
            if indent.columns >= item.contentColumn {
                nestedLines.append(
                    line.replacingContentStart(
                        with: index(afterRemovingColumns: item.contentColumn, from: line)))
                sawBlank = false
                cursor += 1
                continue
            }

            if listItem(in: line) != nil || sawBlank || startsInterruptingBlock(line) {
                break
            }

            nestedLines.append(line)
            cursor += 1
        }

        var scanner = BlockScanner(source: source, lines: nestedLines, definitionLabels: definitionLabels)
        return (scanner.run(), cursor, item.markerCount)
    }

    /// Emits header and body cell prose but skips the delimiter row. The
    /// delimiter configures alignment in MDAST and contributes no prose.
    private func consumeTable(from startIndex: Int, into result: inout BlockResult) -> Int {
        appendTableRow(lines[startIndex], to: &result.prose)
        result.prose.append(ASCII.space)
        var cursor = startIndex + 2
        while cursor < lines.count, !isBlank(lines[cursor]), hasUnescapedPipe(lines[cursor]) {
            appendTableRow(lines[cursor], to: &result.prose)
            cursor += 1
        }
        return cursor
    }

    /// Keeps cell boundaries as separators. Unescaped pipes split cells, while
    /// `\|` remains part of the cell for the inline scanner to unescape.
    private func appendTableRow(_ line: SourceLine, to prose: inout [UInt16]) {
        let cells = tableCells(in: line)
        for cell in cells {
            prose.append(ASCII.space)
            prose.append(contentsOf: InlineScanner(units: Array(slice(cell)), definitionLabels: definitionLabels).run().prose)
            prose.append(ASCII.space)
        }
    }

    /// Collects only a footnote definition's body. The definition label is an
    /// identifier, not prose, while indented continuation lines belong to the
    /// body and must still use absolute source offsets.
    private func consumeFootnote(
        from startIndex: Int, contentStart: Int
    ) -> (lines: [SourceLine], nextIndex: Int) {
        var contentLines = [lines[startIndex].replacingContentStart(with: contentStart)]
        var cursor = startIndex + 1
        while cursor < lines.count {
            let line = lines[cursor]
            if isBlank(line) {
                contentLines.append(line)
                cursor += 1
            } else if indentation(of: line).columns >= 4 {
                contentLines.append(
                    line.replacingContentStart(with: index(afterRemovingColumns: 4, from: line)))
                cursor += 1
            } else {
                break
            }
        }
        return (contentLines, cursor)
    }

    /// Scans paragraph lines while looking one line ahead for a setext underline.
    /// The heading offset skips up to three allowed leading spaces because the
    /// MDAST node starts at the first non-space, not at the physical line start.
    private func consumeParagraph(from startIndex: Int, into result: inout BlockResult) -> Int {
        var paragraphLines: [SourceLine] = []
        var cursor = startIndex

        while cursor < lines.count {
            let line = lines[cursor]
            if isBlank(line) { break }
            if cursor > startIndex, startsInterruptingBlock(line) { break }

            paragraphLines.append(line)
            cursor += 1

            if cursor < lines.count, let depth = setextDepth(lines[cursor]) {
                let inline = inlineContent(paragraphLines)
                result.prose.append(contentsOf: inline.prose)
                result.prose.append(ASCII.space)
                let first = paragraphLines[0]
                let offset = skipSpaces(first.contentStart, limit: first.end, maximum: 3)
                result.headings.append(
                    OutlineHeading(
                        depth: depth,
                        text: trimJSWhitespace(
                            String(decoding: inline.flattened, as: UTF16.self)),
                        offset: offset,
                        index: result.headings.count))
                return cursor + 1
            }
        }

        result.prose.append(contentsOf: inlineContent(paragraphLines).prose)
        result.prose.append(ASCII.space)
        return cursor
    }

    /// Preserves line endings in the buffer sent to `InlineScanner`. A backslash
    /// before a line ending and two trailing spaces create hard breaks, so
    /// dropping the ending would change which MDAST nodes the scanner models.
    private func inlineContent(_ contentLines: [SourceLine]) -> InlineResult {
        var units: [UInt16] = []
        for line in contentLines {
            units.append(contentsOf: slice(line.contentStart..<line.end))
            units.append(contentsOf: slice(line.end..<line.endingEnd))
        }
        return InlineScanner(units: units, definitionLabels: definitionLabels).run()
    }

    /// Whether this line ends an open paragraph rather than continuing it
    /// lazily. Also decides where a blockquote's or list item's lazy
    /// continuation stops.
    private func startsInterruptingBlock(_ line: SourceLine) -> Bool {
        // Type 7 is deliberately absent: CommonMark 4.6 lets every HTML block
        // type except 7 interrupt a paragraph, which is what keeps
        // `alpha\n<span>\nbeta` one paragraph with inline HTML in the middle.
        blockquoteContentStart(line) != nil
            || listItem(in: line) != nil
            || openingFence(in: line) != nil
            || htmlBlockStart(line).map({ $0 != .completeTag }) == true
            || atxHeading(in: line) != nil
            || isThematicBreak(line)
            || footnoteDefinitionContentStart(line) != nil
    }

    private func exactText(_ line: SourceLine, _ text: String) -> Bool {
        slice(line.contentStart..<line.end).elementsEqual(text.utf16)
    }

    private func isBlank(_ line: SourceLine) -> Bool {
        var cursor = line.contentStart
        while cursor < line.end {
            if !isSpaceOrTab(source[cursor]) { return false }
            cursor += 1
        }
        return true
    }

    /// Measures indentation in CommonMark columns, where a tab advances to the
    /// next four-column stop rather than counting as one UTF-16 unit.
    private func indentation(of line: SourceLine) -> (columns: Int, end: Int) {
        var columns = 0
        var cursor = line.contentStart
        while cursor < line.end {
            if source[cursor] == ASCII.space {
                columns += 1
            } else if source[cursor] == ASCII.tab {
                columns += 4 - columns % 4
            } else {
                break
            }
            cursor += 1
        }
        return (columns, cursor)
    }

    /// Converts a visual indentation width back to an absolute UTF-16 index.
    /// Nested scanners need this conversion because tabs occupy one source unit
    /// but can remove up to four indentation columns.
    private func index(afterRemovingColumns columns: Int, from line: SourceLine) -> Int {
        var removed = 0
        var cursor = line.contentStart
        while cursor < line.end, removed < columns {
            if source[cursor] == ASCII.space {
                removed += 1
            } else if source[cursor] == ASCII.tab {
                removed += 4 - removed % 4
            } else {
                break
            }
            cursor += 1
        }
        return cursor
    }

    /// Finds a blockquote marker after CommonMark's permitted zero to three
    /// leading spaces and returns the nested content's absolute start.
    private func blockquoteContentStart(_ line: SourceLine) -> Int? {
        let start = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard start < line.end, source[start] == ASCII.greaterThan else { return nil }
        var contentStart = start + 1
        if contentStart < line.end, isSpaceOrTab(source[contentStart]) { contentStart += 1 }
        return contentStart
    }

    /// The source boundary and visual column needed to scan a list item as a
    /// nested block. `markerCount` also accounts for a task checkbox because it
    /// creates another non-text boundary in MDAST.
    private struct ListItem {
        let contentStart: Int
        let contentColumn: Int
        let markerCount: Int
    }

    /// Recognises CommonMark bullet and ordered markers with at most three
    /// leading columns. Ordered markers are capped at nine digits by the spec.
    private func listItem(in line: SourceLine) -> ListItem? {
        let indent = indentation(of: line)
        guard indent.columns <= 3 else { return nil }
        var cursor = indent.end
        guard cursor < line.end else { return nil }

        if source[cursor] == ASCII.hyphen || source[cursor] == ASCII.plus
            || source[cursor] == ASCII.asterisk
        {
            cursor += 1
        } else {
            let digitsStart = cursor
            while cursor < line.end, source[cursor] >= ASCII.zero, source[cursor] <= ASCII.nine,
                cursor - digitsStart < 9
            {
                cursor += 1
            }
            guard cursor > digitsStart, cursor < line.end,
                source[cursor] == ASCII.period || source[cursor] == ASCII.rightParenthesis
            else { return nil }
            cursor += 1
        }

        guard cursor == line.end || isSpaceOrTab(source[cursor]) else { return nil }
        let markerWidth = cursor - indent.end
        var padding = 0
        while cursor < line.end, isSpaceOrTab(source[cursor]) {
            padding += source[cursor] == ASCII.tab ? 4 : 1
            cursor += 1
        }
        let contentColumn = indent.columns + markerWidth + max(1, padding)
        var markerCount = 1

        if cursor + 3 < line.end, source[cursor] == ASCII.leftBracket,
            source[cursor + 1] == ASCII.space || source[cursor + 1] == 0x78
                || source[cursor + 1] == 0x58,
            source[cursor + 2] == ASCII.rightBracket, isSpaceOrTab(source[cursor + 3])
        {
            cursor += 3
            while cursor < line.end, isSpaceOrTab(source[cursor]) { cursor += 1 }
            markerCount += 1
        }
        return ListItem(
            contentStart: cursor, contentColumn: contentColumn, markerCount: markerCount)
    }

    /// The delimiter identity needed to reject shorter or mismatched closing
    /// fences without retaining the opening line itself.
    private struct Fence {
        let character: UInt16
        let length: Int
    }

    /// Accepts a backtick or tilde fence after at most three leading spaces.
    /// Backticks in a backtick fence's info string invalidate that opener under
    /// CommonMark, which prevents an inline code span from swallowing the line.
    private func openingFence(in line: SourceLine) -> Fence? {
        let start = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard start < line.end,
            source[start] == ASCII.backtick || source[start] == ASCII.tilde
        else { return nil }
        let end = endOfRun(from: start, value: source[start], limit: line.end)
        guard end - start >= 3 else { return nil }
        if source[start] == ASCII.backtick,
            source[end..<line.end].contains(ASCII.backtick)
        {
            return nil
        }
        return Fence(character: source[start], length: end - start)
    }

    /// Requires the closing run to be at least as long as its opener. CommonMark
    /// still permits up to three leading spaces on the closing line.
    private func closingFence(_ line: SourceLine, fence: Fence) -> Bool {
        let start = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard start < line.end, source[start] == fence.character else { return false }
        let end = endOfRun(from: start, value: fence.character, limit: line.end)
        guard end - start >= fence.length else { return false }
        return source[end..<line.end].allSatisfy(isSpaceOrTab)
    }

    /// Heading metadata kept in source coordinates. Closing `#` characters need
    /// a separate flag because they create a syntax separator after the text.
    private struct ATXHeading {
        let depth: Int
        let offset: Int
        let contentStart: Int
        let contentEnd: Int
        let hasClosingSequence: Bool
    }

    /// Applies CommonMark's six-level limit and three-space indent allowance,
    /// then excludes an optional closing `#` sequence from heading text.
    private func atxHeading(in line: SourceLine) -> ATXHeading? {
        let start = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard start < line.end, source[start] == ASCII.hash else { return nil }
        let hashesEnd = endOfRun(from: start, value: ASCII.hash, limit: line.end)
        let depth = hashesEnd - start
        guard depth <= 6, hashesEnd == line.end || isSpaceOrTab(source[hashesEnd]) else {
            return nil
        }

        var contentStart = hashesEnd
        while contentStart < line.end, isSpaceOrTab(source[contentStart]) { contentStart += 1 }
        var contentEnd = line.end
        while contentEnd > contentStart, isSpaceOrTab(source[contentEnd - 1]) { contentEnd -= 1 }
        var closingStart = contentEnd
        while closingStart > contentStart, source[closingStart - 1] == ASCII.hash {
            closingStart -= 1
        }
        let hasClosingSequence = closingStart < contentEnd && closingStart > hashesEnd
            && isSpaceOrTab(source[closingStart - 1])
        if hasClosingSequence {
            contentEnd = closingStart - 1
            while contentEnd > contentStart, isSpaceOrTab(source[contentEnd - 1]) {
                contentEnd -= 1
            }
        }
        return ATXHeading(
            depth: depth, offset: start, contentStart: contentStart, contentEnd: contentEnd,
            hasClosingSequence: hasClosingSequence)
    }

    /// Recognises a setext underline only when the rest of the line is spaces or
    /// tabs. The caller decides whether a preceding paragraph makes it a heading.
    private func setextDepth(_ line: SourceLine) -> Int? {
        var cursor = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard cursor < line.end,
            source[cursor] == ASCII.equals || source[cursor] == ASCII.hyphen
        else { return nil }
        let marker = source[cursor]
        let runEnd = endOfRun(from: cursor, value: marker, limit: line.end)
        cursor = runEnd
        while cursor < line.end, isSpaceOrTab(source[cursor]) { cursor += 1 }
        guard cursor == line.end else { return nil }
        return marker == ASCII.equals ? 1 : 2
    }

    private func isThematicBreak(_ line: SourceLine) -> Bool {
        var cursor = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard cursor < line.end,
            source[cursor] == ASCII.hyphen || source[cursor] == ASCII.asterisk
                || source[cursor] == ASCII.underscore
        else { return false }
        let marker = source[cursor]
        var count = 0
        while cursor < line.end {
            if source[cursor] == marker {
                count += 1
            } else if !isSpaceOrTab(source[cursor]) {
                return false
            }
            cursor += 1
        }
        return count >= 3
    }

    /// The termination rules for the implemented CommonMark HTML block forms.
    /// Raw tags are type 1, comments are type 2, and blank-line termination is
    /// shared by types 6 and 7.
    /// Which CommonMark HTML block type started here. Only the four we need are
    /// implemented; the distinction the rest of the scanner cares about is
    /// `completeTag` (type 7), the one type that may **not** interrupt an open
    /// paragraph.
    private enum HTMLBlock: Equatable {
        /// Type 1: `<script`, `<pre`, `<style`, `<textarea`.
        case rawTag(String)
        /// Type 2: `<!--`.
        case comment
        /// Type 6: a known block-level tag name.
        case untilBlank
        /// Type 7: a complete tag alone on the line.
        case completeTag
    }

    /// Recognises CommonMark HTML block types 1, 2, 6, and 7 only.
    ///
    /// Type 7 is needed to keep a complete tag on its own line block-level while
    /// leaving `<span>safe</span>` inside a paragraph as inline HTML around the
    /// text node `safe`. By contrast, `<script>alert(1)</script>` is type 1 and
    /// contributes no prose. Corpus case 24 fixes that distinction.
    private func htmlBlockStart(_ line: SourceLine) -> HTMLBlock? {
        let start = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard start < line.end, source[start] == ASCII.lessThan else { return nil }
        if starts(with: "<!--", at: start, limit: line.end, caseInsensitive: false) {
            return .comment
        }
        for tag in ["script", "pre", "style", "textarea"] {
            let tagStart = start + 1
            if starts(with: tag, at: tagStart, limit: line.end, caseInsensitive: true),
                tagStart + tag.utf16.count == line.end
                    || isTagBoundary(source[tagStart + tag.utf16.count])
            {
                return .rawTag(tag)
            }
        }
        if let name = tagName(at: start, limit: line.end), Self.blockTags.contains(name.lowercased()) {
            return .untilBlank
        }
        if completeTagLine(from: start, lineEnd: line.end) {
            return .completeTag
        }
        return nil
    }

    /// Uses each implemented HTML block type's CommonMark ending condition:
    /// matching raw close tag, comment close marker, or the next blank line.
    private func consumeHTMLBlock(from startIndex: Int, kind: HTMLBlock) -> Int {
        var cursor = startIndex
        switch kind {
        case .rawTag(let tag):
            let close = "</\(tag)>"
            while cursor < lines.count {
                let line = lines[cursor]
                cursor += 1
                if contains(close, in: line, caseInsensitive: true) { break }
            }
        case .comment:
            while cursor < lines.count {
                let line = lines[cursor]
                cursor += 1
                if contains("-->", in: line, caseInsensitive: false) { break }
            }
        // Types 6 and 7 both end at the next blank line; they differ only in
        // whether they may interrupt a paragraph, which `startsInterruptingBlock`
        // decides before we ever get here.
        case .untilBlank, .completeTag:
            cursor += 1
            while cursor < lines.count, !isBlank(lines[cursor]) { cursor += 1 }
        }
        return cursor
    }

    /// Reads enough of an opening or closing tag to classify block type 6. It
    /// deliberately leaves attribute syntax to the complete-tag check.
    private func tagName(at start: Int, limit: Int) -> String? {
        var cursor = start + 1
        if cursor < limit, source[cursor] == ASCII.slash { cursor += 1 }
        let nameStart = cursor
        while cursor < limit, isASCIILetterOrDigit(source[cursor]) || source[cursor] == ASCII.hyphen {
            cursor += 1
        }
        guard cursor > nameStart, cursor == limit || isTagBoundary(source[cursor]) else { return nil }
        return String(decoding: source[nameStart..<cursor], as: UTF16.self)
    }

    /// Type 7 requires a complete open or closing tag followed only by spaces.
    /// InlineScanner owns the shared quote-aware tag boundary check.
    private func completeTagLine(from start: Int, lineEnd: Int) -> Bool {
        guard tagName(at: start, limit: lineEnd) != nil,
            let tagEnd = InlineScanner.tagEnd(in: source, from: start)
        else { return false }
        var cursor = tagEnd
        while cursor < lineEnd, isSpaceOrTab(source[cursor]) { cursor += 1 }
        return cursor == lineEnd
    }

    /// Treats a pipe as structural only after an even backslash run. `\|` is a
    /// literal pipe, while `\\|` is an escaped backslash followed by a separator.
    private func hasUnescapedPipe(_ line: SourceLine) -> Bool {
        var cursor = line.contentStart
        var backslashes = 0
        while cursor < line.end {
            if source[cursor] == ASCII.backslash {
                backslashes += 1
            } else {
                if source[cursor] == ASCII.pipe, backslashes.isMultiple(of: 2) { return true }
                backslashes = 0
            }
            cursor += 1
        }
        return false
    }

    /// Checks the GFM alignment row shape. Pipes separate cells, optional colons
    /// set alignment, and the hyphens are syntax rather than prose.
    private func isTableDelimiter(_ line: SourceLine) -> Bool {
        let cells = tableCells(in: line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { range in
            var start = range.lowerBound
            var end = range.upperBound
            while start < end, isSpaceOrTab(source[start]) { start += 1 }
            while end > start, isSpaceOrTab(source[end - 1]) { end -= 1 }
            if start < end, source[start] == ASCII.colon { start += 1 }
            if end > start, source[end - 1] == ASCII.colon { end -= 1 }
            guard start < end else { return false }
            return source[start..<end].allSatisfy { $0 == ASCII.hyphen }
        }
    }

    /// Splits a table row on unescaped pipes without copying cell contents.
    /// Leading and trailing pipes create empty edge ranges that are syntax and
    /// must not become cells; `\|` remains inside its cell.
    private func tableCells(in line: SourceLine) -> [Range<Int>] {
        var ranges: [Range<Int>] = []
        var cellStart = line.contentStart
        var cursor = line.contentStart
        var backslashes = 0
        while cursor < line.end {
            let value = source[cursor]
            if value == ASCII.backslash {
                backslashes += 1
            } else {
                if value == ASCII.pipe, backslashes.isMultiple(of: 2) {
                    ranges.append(cellStart..<cursor)
                    cellStart = cursor + 1
                }
                backslashes = 0
            }
            cursor += 1
        }
        ranges.append(cellStart..<line.end)

        if let first = ranges.first, source[first].allSatisfy(isSpaceOrTab) { ranges.removeFirst() }
        if let last = ranges.last, source[last].allSatisfy(isSpaceOrTab) { ranges.removeLast() }
        return ranges
    }

    /// Returns the body start for `[^label]: body`. The label identifies the
    /// definition and contributes no prose; only the body crosses into inline
    /// scanning.
    private func footnoteDefinitionContentStart(_ line: SourceLine) -> Int? {
        var cursor = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard cursor + 3 < line.end, source[cursor] == ASCII.leftBracket,
            source[cursor + 1] == ASCII.caret
        else { return nil }
        cursor += 2
        let labelStart = cursor
        while cursor < line.end, source[cursor] != ASCII.rightBracket { cursor += 1 }
        guard cursor > labelStart, cursor < line.end, cursor + 1 < line.end,
            source[cursor + 1] == ASCII.colon
        else {
            return nil
        }
        cursor += 2
        while cursor < line.end, isSpaceOrTab(source[cursor]) { cursor += 1 }
        return cursor
    }

    /// Recognises a link reference definition by source shape without resolving
    /// its label. Definitions produce no MDAST prose, including an optional
    /// title on the same line or one indented continuation line.
    private func linkReferenceDefinitionEnd(from lineIndex: Int) -> Int? {
        let line = lines[lineIndex]
        var cursor = skipSpaces(line.contentStart, limit: line.end, maximum: 3)
        guard cursor < line.end, source[cursor] == ASCII.leftBracket,
            cursor + 1 < line.end, source[cursor + 1] != ASCII.caret
        else { return nil }
        cursor += 1
        let labelStart = cursor
        while cursor < line.end, source[cursor] != ASCII.rightBracket { cursor += 1 }
        guard cursor > labelStart, cursor + 1 < line.end, source[cursor + 1] == ASCII.colon else {
            return nil
        }
        cursor += 2
        while cursor < line.end, isSpaceOrTab(source[cursor]) { cursor += 1 }
        guard cursor < line.end else { return nil }

        while cursor < line.end, !isSpaceOrTab(source[cursor]) { cursor += 1 }
        while cursor < line.end, isSpaceOrTab(source[cursor]) { cursor += 1 }
        if cursor == line.end {
            if lineIndex + 1 < lines.count,
                indentation(of: lines[lineIndex + 1]).columns > 0,
                isLinkTitle(trimmedRange(of: lines[lineIndex + 1]))
            {
                return lineIndex + 2
            }
            return lineIndex + 1
        }
        return isLinkTitle(cursor..<line.end) ? lineIndex + 1 : nil
    }

    private func isLinkTitle(_ range: Range<Int>) -> Bool {
        guard range.count >= 2 else { return false }
        let first = source[range.lowerBound]
        let last = source[range.upperBound - 1]
        return (first == ASCII.quote && last == ASCII.quote)
            || (first == ASCII.apostrophe && last == ASCII.apostrophe)
            || (first == ASCII.leftParenthesis && last == ASCII.rightParenthesis)
    }

    private func trimmedRange(of line: SourceLine) -> Range<Int> {
        var start = line.contentStart
        var end = line.end
        while start < end, isSpaceOrTab(source[start]) { start += 1 }
        while end > start, isSpaceOrTab(source[end - 1]) { end -= 1 }
        return start..<end
    }

    private func skipSpaces(_ start: Int, limit: Int, maximum: Int) -> Int {
        var cursor = start
        while cursor < limit, cursor - start < maximum, source[cursor] == ASCII.space {
            cursor += 1
        }
        return cursor
    }

    private func endOfRun(from start: Int, value: UInt16, limit: Int) -> Int {
        var cursor = start
        while cursor < limit, source[cursor] == value { cursor += 1 }
        return cursor
    }

    private func starts(
        with text: String, at start: Int, limit: Int, caseInsensitive: Bool
    ) -> Bool {
        let units = Array(text.utf16)
        guard start + units.count <= limit else { return false }
        for index in units.indices {
            let actual = source[start + index]
            let expected = units[index]
            if caseInsensitive {
                if asciiLowercased(actual) != asciiLowercased(expected) { return false }
            } else if actual != expected {
                return false
            }
        }
        return true
    }

    private func contains(_ text: String, in line: SourceLine, caseInsensitive: Bool) -> Bool {
        var cursor = line.contentStart
        while cursor < line.end {
            if starts(with: text, at: cursor, limit: line.end, caseInsensitive: caseInsensitive) {
                return true
            }
            cursor += 1
        }
        return false
    }

    private func slice(_ range: Range<Int>) -> ArraySlice<UInt16> {
        source[range]
    }
}

/// Models the inline nodes that affect prose and flattened heading text without
/// building an MDAST. It tokenises first so delimiter runs can be classified
/// with both their surrounding characters and a later matching run.
private struct InlineScanner {
    let units: [UInt16]
    let definitionLabels: Set<String>

    /// A possible emphasis or deletion delimiter. Its token index lets the
    /// pairing pass replace matched syntax while preserving unmatched literals.
    private struct Delimiter {
        let tokenIndex: Int
        let character: UInt16
        let length: Int
        let canOpen: Bool
        let canClose: Bool
    }

    /// A delayed inline emission. The cases preserve the distinction between
    /// MDAST text children, non-text nodes, and nodes whose `value` is visible
    /// only to outline flattening.
    private enum Token {
        /// An MDAST `text` node's characters: prose and heading text both take it.
        case text([UInt16])
        /// A construct with no `text` child — an image, a footnote reference, a
        /// paired emphasis delimiter. Prose gets the one space that stands in
        /// for remark's `join(" ")`; heading text gets nothing.
        case separator
        /// A node that carries a `value` but no `text` child: a code span, raw
        /// inline HTML. `countWords` visits only `text` nodes, so prose still
        /// gets a separator — but `lib/outline/extract.ts` flattens headings
        /// with `"value" in node`, which picks these up, so heading text gets
        /// the value. `# A \`code\` heading` is "A code heading" in the outline
        /// and three words in the count.
        case value([UInt16])
        /// An emphasis run whose pairing is still undecided.
        case delimiter([UInt16])
    }

    /// Defers delimiter emission until CommonMark's flanking and pairing rules
    /// decide whether each run is syntax or literal text.
    func run() -> InlineResult {
        var tokens: [Token] = []
        var delimiters: [Delimiter] = []
        var cursor = 0

        while cursor < units.count {
            if units[cursor] == ASCII.backslash {
                if let endingEnd = lineEndingEnd(at: cursor + 1) {
                    tokens.append(.separator)
                    cursor = endingEnd
                } else if cursor + 1 < units.count, isASCIIPunctuation(units[cursor + 1]) {
                    tokens.append(.text([units[cursor + 1]]))
                    cursor += 2
                } else {
                    tokens.append(.text([units[cursor]]))
                    cursor += 1
                }
                continue
            }

            if units[cursor] == ASCII.backtick {
                let runEnd = endOfRun(from: cursor, value: ASCII.backtick)
                if let closeEnd = codeSpanClose(after: runEnd, length: runEnd - cursor) {
                    let closeStart = closeEnd - (runEnd - cursor)
                    tokens.append(.value(Self.codeSpanValue(units[runEnd..<closeStart])))
                    cursor = closeEnd
                } else {
                    tokens.append(.text(Array(units[cursor..<runEnd])))
                    cursor = runEnd
                }
                continue
            }

            if units[cursor] == ASCII.lessThan {
                if let autolinkEnd = autolinkEnd(from: cursor) {
                    tokens.append(.separator)
                    tokens.append(.text(Array(units[(cursor + 1)..<(autolinkEnd - 1)])))
                    tokens.append(.separator)
                    cursor = autolinkEnd
                    continue
                }
                // Raw HTML is an `html` node, which carries the source verbatim
                // as its `value` — comment markers and angle brackets included.
                if starts(with: "<!--", at: cursor), let end = find("-->", after: cursor + 4) {
                    tokens.append(.value(Array(units[cursor..<end])))
                    cursor = end
                    continue
                }
                if let end = Self.tagEnd(in: units, from: cursor) {
                    tokens.append(.value(Array(units[cursor..<end])))
                    cursor = end
                    continue
                }
            }

            if units[cursor] == ASCII.exclamation, cursor + 1 < units.count,
                units[cursor + 1] == ASCII.leftBracket,
                let close = matchingBracket(from: cursor + 1),
                let constructEnd = referenceSuffixEnd(after: close + 1)
            {
                tokens.append(.separator)
                cursor = constructEnd
                continue
            }

            if units[cursor] == ASCII.leftBracket {
                if cursor + 2 < units.count, units[cursor + 1] == ASCII.caret,
                    let close = first(ASCII.rightBracket, after: cursor + 2)
                {
                    tokens.append(.separator)
                    cursor = close + 1
                    continue
                }
                if let close = matchingBracket(from: cursor),
                    let end = linkEnd(open: cursor, close: close)
                {
                    let child = InlineScanner(
                        units: Array(units[(cursor + 1)..<close]),
                        definitionLabels: definitionLabels
                    ).run()
                    tokens.append(.separator)
                    tokens.append(.text(child.flattened))
                    tokens.append(.separator)
                    cursor = end
                    continue
                }
            }

            if units[cursor] == ASCII.asterisk || units[cursor] == ASCII.underscore
                || units[cursor] == ASCII.tilde
            {
                let value = units[cursor]
                let runEnd = endOfRun(from: cursor, value: value)
                let flanking = flanking(for: cursor..<runEnd, character: value)
                let tokenIndex = tokens.count
                tokens.append(.delimiter(Array(units[cursor..<runEnd])))
                delimiters.append(
                    Delimiter(
                        tokenIndex: tokenIndex, character: value, length: runEnd - cursor,
                        canOpen: flanking.canOpen, canClose: flanking.canClose))
                cursor = runEnd
                continue
            }

            if units[cursor] == ASCII.space {
                let spacesEnd = endOfRun(from: cursor, value: ASCII.space)
                if spacesEnd - cursor >= 2, let endingEnd = lineEndingEnd(at: spacesEnd) {
                    tokens.append(.separator)
                    cursor = endingEnd
                } else {
                    tokens.append(.text(Array(units[cursor..<spacesEnd])))
                    cursor = spacesEnd
                }
                continue
            }

            if let endingEnd = lineEndingEnd(at: cursor) {
                tokens.append(.text(Array(units[cursor..<endingEnd])))
                cursor = endingEnd
                continue
            }

            let textEnd = nextSpecial(after: cursor)
            tokens.append(.text(Array(units[cursor..<textEnd])))
            cursor = textEnd
        }

        let paired = pairedDelimiterTokenIndices(delimiters)
        var prose: [UInt16] = []
        var flattened: [UInt16] = []
        for (index, token) in tokens.enumerated() {
            switch token {
            case .text(let text):
                prose.append(contentsOf: text)
                flattened.append(contentsOf: text)
            case .separator:
                prose.append(ASCII.space)
            case .value(let value):
                prose.append(ASCII.space)
                flattened.append(contentsOf: value)
            case .delimiter(let text):
                if paired.contains(index) {
                    prose.append(ASCII.space)
                } else {
                    prose.append(contentsOf: text)
                    flattened.append(contentsOf: text)
                }
            }
        }
        return InlineResult(prose: prose, flattened: flattened)
    }

    /// Finds delimiter runs that become syntax instead of prose.
    ///
    /// Treating every `*` or `_` as a separator would corrupt ordinary text:
    /// `foo_bar_baz` must remain one word, `2 * 3 * 4` must retain its two
    /// asterisk tokens, and `2**3` must remain one word. The pairing pass keeps
    /// unmatched runs literal while removing paired emphasis syntax.
    /// Where a link ends, or nil when the brackets are not a link at all.
    ///
    /// `[text](dest)` always is. `[text][ref]`, `[text][]` and a bare `[text]`
    /// are `linkReference` nodes only when the label they resolve to has a
    /// definition; without one remark emits the brackets as literal text, and
    /// `foo[bar]baz` counts as one word rather than three.
    private func linkEnd(open: Int, close: Int) -> Int? {
        let suffix = referenceSuffixEnd(after: close + 1)
        if let suffix, units[close + 1] == ASCII.leftParenthesis { return suffix }
        if let suffix {
            // `[text][ref]`, or `[text][]` which reuses the text as the label.
            let label =
                suffix - 1 > close + 2
                ? units[(close + 2)..<(suffix - 1)] : units[(open + 1)..<close]
            return definitionLabels.contains(MarkdownProse.Walker.normalizedLabel(label))
                ? suffix : nil
        }
        return definitionLabels.contains(
            MarkdownProse.Walker.normalizedLabel(units[(open + 1)..<close]))
            ? close + 1 : nil
    }

    private func pairedDelimiterTokenIndices(_ delimiters: [Delimiter]) -> Set<Int> {
        var openers: [Delimiter] = []
        var paired: Set<Int> = []
        for delimiter in delimiters {
            var didClose = false
            if delimiter.canClose,
                let openerIndex = openers.lastIndex(where: {
                    $0.character == delimiter.character
                        && canPair($0, delimiter)
                })
            {
                let opener = openers.remove(at: openerIndex)
                paired.insert(opener.tokenIndex)
                paired.insert(delimiter.tokenIndex)
                didClose = true
            }
            if delimiter.canOpen, !didClose { openers.append(delimiter) }
        }
        return paired
    }

    /// Applies CommonMark's "rule of three" to runs that can both open and
    /// close. It prevents ambiguous intraword runs from pairing merely because
    /// their delimiter characters match. Tilde runs must also have equal width.
    private func canPair(_ opener: Delimiter, _ closer: Delimiter) -> Bool {
        guard opener.character == closer.character else { return false }
        if opener.character == ASCII.tilde { return opener.length == closer.length }
        if opener.canClose || closer.canOpen {
            let sum = opener.length + closer.length
            if sum.isMultiple(of: 3),
                !opener.length.isMultiple(of: 3) || !closer.length.isMultiple(of: 3)
            {
                return false
            }
        }
        return true
    }

    /// Computes CommonMark left- and right-flanking status from the Unicode
    /// whitespace and punctuation on each side. The underscore exceptions keep
    /// intraword text such as `foo_bar_baz` from becoming emphasis.
    private func flanking(
        for range: Range<Int>, character: UInt16
    ) -> (canOpen: Bool, canClose: Bool) {
        let before = scalar(before: range.lowerBound)
        let after = scalar(at: range.upperBound)
        let beforeWhitespace = before.map(isUnicodeWhitespace) ?? true
        let afterWhitespace = after.map(isUnicodeWhitespace) ?? true
        let beforePunctuation = before.map(isUnicodePunctuation) ?? false
        let afterPunctuation = after.map(isUnicodePunctuation) ?? false
        let leftFlanking = !afterWhitespace
            && (!afterPunctuation || beforeWhitespace || beforePunctuation)
        let rightFlanking = !beforeWhitespace
            && (!beforePunctuation || afterWhitespace || afterPunctuation)

        if character == ASCII.underscore {
            return (
                leftFlanking && (!rightFlanking || beforePunctuation),
                rightFlanking && (!leftFlanking || afterPunctuation)
            )
        }
        return (leftFlanking, rightFlanking)
    }

    /// A code span's `value`, as `mdast-util-from-markdown` computes it.
    ///
    /// CommonMark strips one space from each end when the content both begins
    /// and ends with a space and is not all spaces, so `` ` a ` `` is "a" but
    /// `` `  ` `` is " ".
    ///
    /// Line endings are kept verbatim. The CommonMark *spec* says they become
    /// spaces, but mdast does not do that to the node's `value` — a code span
    /// broken across two lines inside a setext heading comes back from remark
    /// with the newline still in it, and the outline has to match remark, not
    /// the spec.
    private static func codeSpanValue(_ units: ArraySlice<UInt16>) -> [UInt16] {
        var value = Array(units)
        if value.count >= 2, value.first == ASCII.space, value.last == ASCII.space,
            value.contains(where: { $0 != ASCII.space })
        {
            value.removeFirst()
            value.removeLast()
        }
        return value
    }

    private func codeSpanClose(after start: Int, length: Int) -> Int? {
        var cursor = start
        while cursor < units.count {
            if units[cursor] == ASCII.backtick {
                let end = endOfRun(from: cursor, value: ASCII.backtick)
                if end - cursor == length { return end }
                cursor = end
            } else {
                cursor += 1
            }
        }
        return nil
    }

    /// Accepts CommonMark URI and email autolink shapes inside `<...>`.
    /// URI schemes are one to 32 characters by spec. Unlike raw HTML, an
    /// autolink is a `link` whose child is a `text` node equal to the URL or
    /// address, so that visible value counts as prose.
    private func autolinkEnd(from start: Int) -> Int? {
        guard let close = first(ASCII.greaterThan, after: start + 1), close > start + 1 else {
            return nil
        }
        let inner = Array(units[(start + 1)..<close])
        guard !inner.contains(where: { $0 <= ASCII.space || $0 == ASCII.lessThan }) else {
            return nil
        }

        if let colon = inner.firstIndex(of: ASCII.colon), colon >= 1, colon <= 32,
            isASCIILetter(inner[0]), inner[0..<colon].dropFirst().allSatisfy({
                isASCIILetterOrDigit($0) || $0 == ASCII.plus || $0 == ASCII.hyphen
                    || $0 == ASCII.period
            })
        {
            return close + 1
        }
        if let at = inner.firstIndex(of: ASCII.at), at > 0, at < inner.count - 1,
            !inner[(at + 1)...].contains(ASCII.at)
        {
            return close + 1
        }
        return nil
    }

    /// Finds the closing bracket for link text or an image label. Nested brackets
    /// count toward depth, and a backslash protects the next unit from changing
    /// that depth.
    private func matchingBracket(from open: Int) -> Int? {
        var depth = 1
        var cursor = open + 1
        while cursor < units.count {
            if units[cursor] == ASCII.backslash, cursor + 1 < units.count {
                cursor += 2
                continue
            }
            if units[cursor] == ASCII.leftBracket {
                depth += 1
            } else if units[cursor] == ASCII.rightBracket {
                depth -= 1
                if depth == 0 { return cursor }
            }
            cursor += 1
        }
        return nil
    }

    /// Accepts either an inline link suffix with balanced parentheses and quoted
    /// text, or a full reference suffix `[label]`. A missing suffix leaves the
    /// bracketed text as a shortcut or collapsed reference candidate.
    private func referenceSuffixEnd(after start: Int) -> Int? {
        guard start < units.count else { return nil }
        if units[start] == ASCII.leftParenthesis {
            var depth = 1
            var quote: UInt16?
            var cursor = start + 1
            while cursor < units.count {
                let value = units[cursor]
                if value == ASCII.backslash, cursor + 1 < units.count {
                    cursor += 2
                    continue
                }
                if let activeQuote = quote {
                    if value == activeQuote { quote = nil }
                } else if value == ASCII.quote || value == ASCII.apostrophe {
                    quote = value
                } else if value == ASCII.leftParenthesis {
                    depth += 1
                } else if value == ASCII.rightParenthesis {
                    depth -= 1
                    if depth == 0 { return cursor + 1 }
                }
                cursor += 1
            }
        } else if units[start] == ASCII.leftBracket,
            let close = first(ASCII.rightBracket, after: start + 1)
        {
            return close + 1
        }
        return nil
    }

    /// Finds a complete single-line HTML tag while ignoring `>` inside quoted
    /// attributes. Block type 7 detection shares this boundary logic with inline
    /// HTML so the two scanners do not disagree about tag shape.
    static func tagEnd(in units: [UInt16], from start: Int) -> Int? {
        guard start + 2 < units.count, units[start] == ASCII.lessThan else { return nil }
        var cursor = start + 1
        if units[cursor] == ASCII.slash { cursor += 1 }
        guard cursor < units.count, isASCIILetter(units[cursor]) else { return nil }
        while cursor < units.count, isASCIILetterOrDigit(units[cursor]) || units[cursor] == ASCII.hyphen {
            cursor += 1
        }
        var quote: UInt16?
        while cursor < units.count {
            let value = units[cursor]
            if let activeQuote = quote {
                if value == activeQuote { quote = nil }
            } else if value == ASCII.quote || value == ASCII.apostrophe {
                quote = value
            } else if value == ASCII.greaterThan {
                return cursor + 1
            } else if value == ASCII.lessThan || value == ASCII.lineFeed
                || value == ASCII.carriageReturn
            {
                return nil
            }
            cursor += 1
        }
        return nil
    }

    /// Returns the boundary after one physical line ending. CRLF advances two
    /// UTF-16 units even though inline parsing treats it as one ending.
    private func lineEndingEnd(at start: Int) -> Int? {
        guard start < units.count else { return nil }
        if units[start] == ASCII.lineFeed { return start + 1 }
        if units[start] == ASCII.carriageReturn {
            return start + 1 < units.count && units[start + 1] == ASCII.lineFeed
                ? start + 2 : start + 1
        }
        return nil
    }

    private func nextSpecial(after start: Int) -> Int {
        var cursor = start + 1
        while cursor < units.count {
            let value = units[cursor]
            if value == ASCII.backslash || value == ASCII.backtick || value == ASCII.lessThan
                || value == ASCII.exclamation || value == ASCII.leftBracket
                || value == ASCII.asterisk || value == ASCII.underscore || value == ASCII.tilde
                || value == ASCII.space || value == ASCII.lineFeed || value == ASCII.carriageReturn
            {
                break
            }
            cursor += 1
        }
        return cursor
    }

    private func endOfRun(from start: Int, value: UInt16) -> Int {
        var cursor = start
        while cursor < units.count, units[cursor] == value { cursor += 1 }
        return cursor
    }

    private func starts(with text: String, at start: Int) -> Bool {
        let expected = Array(text.utf16)
        guard start + expected.count <= units.count else { return false }
        return units[start..<(start + expected.count)].elementsEqual(expected)
    }

    private func find(_ text: String, after start: Int) -> Int? {
        let expected = Array(text.utf16)
        guard !expected.isEmpty else { return start }
        var cursor = start
        while cursor + expected.count <= units.count {
            if units[cursor..<(cursor + expected.count)].elementsEqual(expected) {
                return cursor + expected.count
            }
            cursor += 1
        }
        return nil
    }

    private func first(_ value: UInt16, after start: Int) -> Int? {
        var cursor = start
        while cursor < units.count {
            if units[cursor] == value { return cursor }
            cursor += 1
        }
        return nil
    }

    /// Decodes one scalar without changing the UTF-16 index used by delimiter
    /// ranges. Flanking classification needs Unicode properties, but offsets
    /// must remain measured in code units.
    private func scalar(at index: Int) -> UnicodeScalar? {
        guard index < units.count else { return nil }
        let first = units[index]
        if first >= 0xD800, first <= 0xDBFF, index + 1 < units.count {
            let second = units[index + 1]
            guard second >= 0xDC00, second <= 0xDFFF else { return UnicodeScalar(first) }
            let value = 0x10000 + (UInt32(first - 0xD800) << 10) + UInt32(second - 0xDC00)
            return UnicodeScalar(value)
        }
        return UnicodeScalar(first)
    }

    /// Decodes the scalar ending before a UTF-16 boundary, including a surrogate
    /// pair that occupies the two preceding units.
    private func scalar(before index: Int) -> UnicodeScalar? {
        guard index > 0 else { return nil }
        let last = units[index - 1]
        if last >= 0xDC00, last <= 0xDFFF, index >= 2 {
            let first = units[index - 2]
            guard first >= 0xD800, first <= 0xDBFF else { return UnicodeScalar(last) }
            let value = 0x10000 + (UInt32(first - 0xD800) << 10) + UInt32(last - 0xDC00)
            return UnicodeScalar(value)
        }
        return UnicodeScalar(last)
    }
}

/// Matches JavaScript `String.trim` rather than Foundation's whitespace sets.
/// JavaScript `\s` excludes U+200B ZERO WIDTH SPACE, while
/// `CharacterSet.whitespacesAndNewlines` includes it.
private func trimJSWhitespace(_ value: String) -> String {
    var start = value.unicodeScalars.startIndex
    var end = value.unicodeScalars.endIndex
    while start < end, MarkdownProse.isJSWhitespace(value.unicodeScalars[start]) {
        start = value.unicodeScalars.index(after: start)
    }
    while end > start {
        let previous = value.unicodeScalars.index(before: end)
        guard MarkdownProse.isJSWhitespace(value.unicodeScalars[previous]) else { break }
        end = previous
    }
    return String(value.unicodeScalars[start..<end])
}

private func isSpaceOrTab(_ value: UInt16) -> Bool {
    value == ASCII.space || value == ASCII.tab
}

private func isTagBoundary(_ value: UInt16) -> Bool {
    isSpaceOrTab(value) || value == ASCII.greaterThan || value == ASCII.slash
}

private func isASCIILetter(_ value: UInt16) -> Bool {
    (value >= 0x41 && value <= 0x5A) || (value >= 0x61 && value <= 0x7A)
}

private func isASCIILetterOrDigit(_ value: UInt16) -> Bool {
    isASCIILetter(value) || (value >= ASCII.zero && value <= ASCII.nine)
}

private func asciiLowercased(_ value: UInt16) -> UInt16 {
    value >= 0x41 && value <= 0x5A ? value + 0x20 : value
}

private func isASCIIPunctuation(_ value: UInt16) -> Bool {
    (value >= 0x21 && value <= 0x2F) || (value >= 0x3A && value <= 0x40)
        || (value >= 0x5B && value <= 0x60) || (value >= 0x7B && value <= 0x7E)
}

/// Keeps delimiter flanking aligned with the JavaScript implementation's `\s`
/// semantics. Foundation would classify U+200B differently.
private func isUnicodeWhitespace(_ scalar: UnicodeScalar) -> Bool {
    MarkdownProse.isJSWhitespace(scalar)
}

private func isUnicodePunctuation(_ scalar: UnicodeScalar) -> Bool {
    CharacterSet.punctuationCharacters.contains(scalar)
}
