import Foundation
import MarkdownEngine

public nonisolated enum RectoEditorCommand: Hashable, Sendable {
    case bold
    case italic
    case strikethrough
    case inlineCode
    case heading(level: Int)
    case bulletList
    case orderedList
    case taskList
    case blockquote
    case codeBlock(language: String)
    case divider
    case table(rows: Int, columns: Int)
    case link(destination: String)
    case image(source: String, alt: String)
    case footnote(identifier: String)

    public var actionName: String {
        switch self {
        case .bold: "Bold"
        case .italic: "Italic"
        case .strikethrough: "Strikethrough"
        case .inlineCode: "Inline Code"
        case let .heading(level): "Heading \(level)"
        case .bulletList: "Bullet List"
        case .orderedList: "Numbered List"
        case .taskList: "Task List"
        case .blockquote: "Blockquote"
        case .codeBlock: "Code Block"
        case .divider: "Divider"
        case .table: "Table"
        case .link: "Link"
        case .image: "Image"
        case .footnote: "Footnote"
        }
    }
}

public struct RectoEditorSelectionState: Equatable, Sendable {
    public let range: NSRange
    public let selectedText: String
    public let activeInlineCommands: Set<RectoEditorCommand>
    public let anchorRect: CGRect?
    public let isEditable: Bool

    public var hasSelection: Bool { range.length > 0 }
    public var canFormatSelection: Bool { isEditable && hasSelection }

    public init(
        range: NSRange = NSRange(location: 0, length: 0),
        selectedText: String = "",
        activeInlineCommands: Set<RectoEditorCommand> = [],
        anchorRect: CGRect? = nil,
        isEditable: Bool = false
    ) {
        self.range = range
        self.selectedText = selectedText
        self.activeInlineCommands = activeInlineCommands
        self.anchorRect = anchorRect
        self.isEditable = isEditable
    }
}

struct RectoCommandEdit: Equatable {
    let patch: MarkdownTextPatch
    let selection: NSRange
    let generatedLineEndingRanges: [NSRange]

    init(
        patch: MarkdownTextPatch,
        selection: NSRange,
        generatedLineEndingRanges: [NSRange] = []
    ) {
        self.patch = patch
        self.selection = selection
        self.generatedLineEndingRanges = generatedLineEndingRanges
    }
}

enum RectoCommandTransformer {
    private enum InputLimit {
        static let language = 100
        static let tableRows = 100
        static let tableColumns = 20
        static let destination = 8_192
        static let altText = 4_096
        static let footnoteIdentifier = 256
    }

    static func edit(
        command: RectoEditorCommand,
        markdown: String,
        selection: NSRange
    ) -> RectoCommandEdit? {
        let source = markdown as NSString
        guard selection.location != NSNotFound,
              selection.length >= 0,
              NSMaxRange(selection) <= source.length else { return nil }

        switch command {
        case .bold:
            return inline(markdown: source, selection: selection, delimiter: "**", placeholder: "text")
        case .italic:
            return inline(markdown: source, selection: selection, delimiter: "_", placeholder: "text")
        case .strikethrough:
            return inline(markdown: source, selection: selection, delimiter: "~~", placeholder: "text")
        case .inlineCode:
            return codeSpan(markdown: source, selection: selection)
        case let .heading(level):
            guard (1...6).contains(level) else { return nil }
            return rewriteLines(
                markdown: source,
                selection: selection,
                command: .heading(String(repeating: "#", count: level) + " ")
            )
        case .bulletList:
            return rewriteLines(markdown: source, selection: selection, command: .list("- "))
        case .orderedList:
            return rewriteLines(markdown: source, selection: selection, command: .list("1. "))
        case .taskList:
            return rewriteLines(markdown: source, selection: selection, command: .list("- [ ] "))
        case .blockquote:
            return rewriteLines(markdown: source, selection: selection, command: .blockquote)
        case let .codeBlock(language):
            let selected = source.substring(with: selection)
            guard (language as NSString).length <= InputLimit.language,
                  !language.contains("`"), !containsControlCharacter(language) else { return nil }
            let info = language.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = selected.isEmpty ? "code" : selected
            let fence = String(repeating: "`", count: max(3, longestRun(of: "`", in: body) + 1))
            let opening = info.isEmpty ? fence : "\(fence)\(info)"
            let separator = body.hasSuffix("\n") || body.hasSuffix("\r") ? "" : "\n"
            let replacement = "\(opening)\n\(body)\(separator)\(fence)"
            let bodyStart = (opening as NSString).length + 1
            return blockEdit(
                markdown: source,
                selection: selection,
                replacement: replacement,
                innerSelection: NSRange(location: bodyStart, length: (body as NSString).length),
                generatedLineEndingRanges: [
                    NSRange(location: 0, length: bodyStart),
                    NSRange(
                        location: bodyStart + (body as NSString).length,
                        length: (separator as NSString).length
                    ),
                ]
            )
        case .divider:
            return replaceSelectedLines(markdown: source, selection: selection, replacement: "---")
        case let .table(rows, columns):
            guard (1...InputLimit.tableRows).contains(rows),
                  (1...InputLimit.tableColumns).contains(columns) else { return nil }
            let header = "| " + Array(repeating: "Header", count: columns).joined(separator: " | ") + " |"
            let separator = "| " + Array(repeating: "---", count: columns).joined(separator: " | ") + " |"
            let body = Array(repeating: "| " + Array(repeating: "Cell", count: columns).joined(separator: " | ") + " |", count: rows - 1)
            let replacement = ([header, separator] + body).joined(separator: "\n")
            return blockEdit(
                markdown: source,
                selection: selection,
                replacement: replacement,
                innerSelection: NSRange(location: 2, length: 6),
                generatedLineEndingRanges: [NSRange(location: 0, length: (replacement as NSString).length)]
            )
        case let .link(destination):
            return link(markdown: source, selection: selection, destination: destination, image: false, alt: "")
        case let .image(imageSource, alt):
            return link(markdown: source, selection: selection, destination: imageSource, image: true, alt: alt)
        case let .footnote(identifier):
            let id = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty,
                  (id as NSString).length <= InputLimit.footnoteIdentifier,
                  !id.contains("]"), !containsControlCharacter(id) else { return nil }
            let selected = source.substring(with: selection)
            let definition = selected.isEmpty ? "Footnote text" : selected
            let reference = "[^\(id)]"
            let tailRange = NSRange(location: NSMaxRange(selection), length: source.length - NSMaxRange(selection))
            let tail = source.substring(with: tailRange)
            let documentAfterReference = source.substring(to: selection.location) + reference + tail
            let separator = blockSeparator(after: documentAfterReference)
            let definitionPrefix = "[^\(id)]: "
            let replacement = reference + tail + separator + definitionPrefix + definition
            return RectoCommandEdit(
                patch: MarkdownTextPatch(
                    range: NSRange(location: selection.location, length: source.length - selection.location),
                    replacement: replacement
                ),
                selection: NSRange(
                    location: selection.location
                        + (reference as NSString).length
                        + (tail as NSString).length
                        + (separator as NSString).length
                        + (definitionPrefix as NSString).length,
                    length: (definition as NSString).length
                ),
                generatedLineEndingRanges: [NSRange(
                    location: (reference as NSString).length + (tail as NSString).length,
                    length: (separator as NSString).length
                )]
            )
        }
    }

    static func activeInlineCommands(markdown: String, selection: NSRange) -> Set<RectoEditorCommand> {
        guard selection.length > 0 else { return [] }
        let source = markdown as NSString
        return [
            (RectoEditorCommand.bold, "**"),
            (.italic, "_"),
            (.strikethrough, "~~"),
        ].reduce(into: Set<RectoEditorCommand>()) { active, item in
            if isWrapped(source, selection: selection, delimiter: item.1) {
                active.insert(item.0)
            }
        }.union(codeSpanWrapper(in: source, selection: selection) == nil ? [] : [.inlineCode])
    }

    private static func inline(
        markdown: NSString,
        selection: NSRange,
        delimiter: String,
        placeholder: String
    ) -> RectoCommandEdit? {
        let delimiterLength = (delimiter as NSString).length
        if selection.length > 0, isWrapped(markdown, selection: selection, delimiter: delimiter) {
            let expanded = NSRange(
                location: selection.location - delimiterLength,
                length: selection.length + delimiterLength * 2
            )
            let selected = markdown.substring(with: selection)
            return RectoCommandEdit(
                patch: MarkdownTextPatch(range: expanded, replacement: selected),
                selection: NSRange(location: expanded.location, length: selection.length)
            )
        }

        let selected = selection.length == 0 ? placeholder : markdown.substring(with: selection)
        let selectedText = selected as NSString
        guard selectedText.range(of: "\n").location == NSNotFound,
              selectedText.range(of: "\r").location == NSNotFound else { return nil }
        var contentStart = 0
        while contentStart < selectedText.length, isWhitespace(selectedText.character(at: contentStart)) {
            contentStart += 1
        }
        var contentEnd = selectedText.length
        while contentEnd > contentStart, isWhitespace(selectedText.character(at: contentEnd - 1)) {
            contentEnd -= 1
        }
        guard contentStart < contentEnd else { return nil }
        let leading = selectedText.substring(to: contentStart)
        let content = selectedText.substring(with: NSRange(location: contentStart, length: contentEnd - contentStart))
        let trailing = selectedText.substring(from: contentEnd)
        let replacement = leading + delimiter + content + delimiter + trailing
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: selection, replacement: replacement),
            selection: NSRange(
                location: selection.location + contentStart + delimiterLength,
                length: (content as NSString).length
            )
        )
    }

    private static func isWrapped(_ markdown: NSString, selection: NSRange, delimiter: String) -> Bool {
        let length = (delimiter as NSString).length
        guard selection.location >= length,
              NSMaxRange(selection) + length <= markdown.length else { return false }
        return markdown.substring(with: NSRange(location: selection.location - length, length: length)) == delimiter
            && markdown.substring(with: NSRange(location: NSMaxRange(selection), length: length)) == delimiter
    }

    private static func codeSpan(markdown: NSString, selection: NSRange) -> RectoCommandEdit {
        if selection.length > 0, let wrapper = codeSpanWrapper(in: markdown, selection: selection) {
            let selected = markdown.substring(with: selection)
            return RectoCommandEdit(
                patch: MarkdownTextPatch(range: wrapper, replacement: selected),
                selection: NSRange(location: wrapper.location, length: selection.length)
            )
        }

        let selected = selection.length == 0 ? "code" : markdown.substring(with: selection)
        let delimiter = String(repeating: "`", count: longestRun(of: "`", in: selected) + 1)
        let hasBoundarySpace = (selected.hasPrefix(" ") || selected.hasSuffix(" "))
            && !selected.allSatisfy { $0 == " " }
        let needsPadding = selected.hasPrefix("`") || selected.hasSuffix("`") || hasBoundarySpace
        let padding = needsPadding ? " " : ""
        let replacement = delimiter + padding + selected + padding + delimiter
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: selection, replacement: replacement),
            selection: NSRange(
                location: selection.location + (delimiter as NSString).length + (padding as NSString).length,
                length: (selected as NSString).length
            )
        )
    }

    private static func codeSpanWrapper(in markdown: NSString, selection: NSRange) -> NSRange? {
        for padding in [0, 1] {
            let leftEnd = selection.location - padding
            let rightStart = NSMaxRange(selection) + padding
            guard leftEnd > 0, rightStart < markdown.length else { continue }
            if padding == 1,
               (markdown.character(at: selection.location - 1) != 32
                || markdown.character(at: NSMaxRange(selection)) != 32) { continue }
            let leftStart = startOfBacktickRun(in: markdown, endingAt: leftEnd)
            let rightEnd = endOfBacktickRun(in: markdown, startingAt: rightStart)
            let leftLength = leftEnd - leftStart
            guard leftLength > 0, rightEnd - rightStart == leftLength else { continue }
            return NSRange(location: leftStart, length: rightEnd - leftStart)
        }
        return nil
    }

    private static func startOfBacktickRun(in markdown: NSString, endingAt end: Int) -> Int {
        var index = end
        while index > 0, markdown.character(at: index - 1) == 96 { index -= 1 }
        return index
    }

    private static func endOfBacktickRun(in markdown: NSString, startingAt start: Int) -> Int {
        var index = start
        while index < markdown.length, markdown.character(at: index) == 96 { index += 1 }
        return index
    }

    private static func longestRun(of character: Character, in value: String) -> Int {
        var longest = 0
        var current = 0
        for candidate in value {
            current = candidate == character ? current + 1 : 0
            longest = max(longest, current)
        }
        return longest
    }

    private static func link(
        markdown: NSString,
        selection: NSRange,
        destination: String,
        image: Bool,
        alt: String
    ) -> RectoCommandEdit? {
        let trimmed = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              (trimmed as NSString).length <= InputLimit.destination,
              !containsControlCharacter(trimmed),
              !image || ((alt as NSString).length <= InputLimit.altText && !containsControlCharacter(alt)) else { return nil }
        let selected = markdown.substring(with: selection)
        let label = image ? (alt.isEmpty ? (selected.isEmpty ? "alt" : selected) : alt) : (selected.isEmpty ? "text" : selected)
        guard !containsControlCharacter(label) else { return nil }
        let prefix = image ? "![" : "["
        let encodedLabel = escapeLinkLabel(label)
        let replacement = "\(prefix)\(encodedLabel)](\(formatLinkDestination(trimmed)))"
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: selection, replacement: replacement),
            selection: NSRange(location: selection.location + (prefix as NSString).length, length: (encodedLabel as NSString).length)
        )
    }

    private static func escapeLinkLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private static func formatLinkDestination(_ destination: String) -> String {
        let escaped = destination.replacingOccurrences(of: "\\", with: "\\\\")
        let hasWhitespace = escaped.contains(where: \Character.isWhitespace)
        var depth = 0
        var balanced = true
        for character in escaped {
            if character == "(" {
                depth += 1
            } else if character == ")" {
                depth -= 1
                if depth < 0 { balanced = false }
            }
        }
        balanced = balanced && depth == 0
        guard hasWhitespace || !balanced else { return escaped }
        return "<\(escaped.replacingOccurrences(of: "<", with: "%3C").replacingOccurrences(of: ">", with: "%3E"))>"
    }

    private static func containsControlCharacter(_ value: String) -> Bool {
        value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private enum LineCommand {
        case heading(String)
        case list(String)
        case blockquote
    }

    private struct LinePrefix {
        let indentationEnd: Int
        let quoteRange: NSRange?
        let outerQuoteRange: NSRange?
        let containerEnd: Int
        let listRange: NSRange?
        let headingRange: NSRange?
    }

    private struct PrefixChange {
        let range: NSRange
        let replacement: String
    }

    private static func rewriteLines(
        markdown: NSString,
        selection: NSRange,
        command: LineCommand
    ) -> RectoCommandEdit {
        let selectedCharacters = selection.length > 0
            ? NSRange(location: selection.location, length: selection.length - 1)
            : selection
        let lineRange = markdown.lineRange(for: selectedCharacters)
        var lines: [(range: NSRange, contents: String, prefix: LinePrefix)] = []
        var cursor = lineRange.location
        while cursor < NSMaxRange(lineRange) {
            var start = 0
            var end = 0
            var contentsEnd = 0
            markdown.getLineStart(&start, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: cursor, length: 0))
            let contentsRange = NSRange(location: start, length: contentsEnd - start)
            let contents = markdown.substring(with: contentsRange)
            lines.append((contentsRange, contents, parsePrefix(in: contents as NSString)))
            cursor = max(end, cursor + 1)
        }
        if lines.isEmpty {
            lines.append((
                NSRange(location: lineRange.location, length: 0),
                "",
                parsePrefix(in: "")
            ))
        }

        let nonEmptyLines = lines.filter { !$0.contents.isEmpty }
        let removesQuote = if case .blockquote = command {
            !nonEmptyLines.isEmpty && nonEmptyLines.allSatisfy { $0.prefix.quoteRange != nil }
        } else {
            false
        }
        var changes: [PrefixChange] = []
        for line in lines where !line.contents.isEmpty || line.range.length == 0 {
            let relative: PrefixChange
            switch command {
            case let .heading(prefix):
                relative = PrefixChange(
                    range: line.prefix.headingRange
                        ?? NSRange(location: NSMaxRange(line.prefix.listRange ?? NSRange(location: line.prefix.containerEnd, length: 0)), length: 0),
                    replacement: prefix
                )
            case let .list(prefix):
                relative = PrefixChange(
                    range: line.prefix.listRange ?? NSRange(location: line.prefix.containerEnd, length: 0),
                    replacement: prefix
                )
            case .blockquote:
                relative = PrefixChange(
                    range: removesQuote
                        ? line.prefix.outerQuoteRange ?? NSRange(location: line.prefix.indentationEnd, length: 0)
                        : NSRange(location: line.prefix.indentationEnd, length: 0),
                    replacement: removesQuote ? "" : "> "
                )
            }
            changes.append(PrefixChange(
                range: NSRange(
                    location: line.range.location + relative.range.location,
                    length: relative.range.length
                ),
                replacement: relative.replacement
            ))
        }

        var replacement = markdown.substring(with: lineRange) as NSString
        for change in changes.reversed() {
            let relative = NSRange(
                location: change.range.location - lineRange.location,
                length: change.range.length
            )
            replacement = replacement.replacingCharacters(in: relative, with: change.replacement) as NSString
        }
        let mappedStart = mapPosition(selection.location, through: changes)
        let mappedEnd = mapPosition(NSMaxRange(selection), through: changes)
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: lineRange, replacement: replacement as String),
            selection: NSRange(location: mappedStart, length: max(0, mappedEnd - mappedStart))
        )
    }

    private static func parsePrefix(in line: NSString) -> LinePrefix {
        var index = consumeWhitespace(in: line, from: 0)
        let indentationEnd = index
        let quoteStart = index
        var outerQuoteRange: NSRange?
        while index < line.length, line.character(at: index) == 62 {
            let markerStart = index
            index += 1
            index = consumeWhitespace(in: line, from: index)
            if outerQuoteRange == nil {
                outerQuoteRange = NSRange(location: markerStart, length: index - markerStart)
            }
        }
        let quoteRange = index > quoteStart
            ? NSRange(location: quoteStart, length: index - quoteStart)
            : nil
        let containerEnd = index
        let listRange = listPrefixRange(in: line, at: index)
        if let listRange { index = NSMaxRange(listRange) }
        let headingRange = headingPrefixRange(in: line, at: index)
        return LinePrefix(
            indentationEnd: indentationEnd,
            quoteRange: quoteRange,
            outerQuoteRange: outerQuoteRange,
            containerEnd: containerEnd,
            listRange: listRange,
            headingRange: headingRange
        )
    }

    private static func listPrefixRange(in line: NSString, at start: Int) -> NSRange? {
        guard start < line.length else { return nil }
        var index = start
        let first = line.character(at: index)
        if first == 45 || first == 43 || first == 42 {
            index += 1
        } else if isDigit(first) {
            repeat { index += 1 } while index < line.length && isDigit(line.character(at: index))
            guard index - start <= 9,
                  index < line.length,
                  line.character(at: index) == 46 || line.character(at: index) == 41 else { return nil }
            index += 1
        } else {
            return nil
        }
        guard index < line.length, isWhitespace(line.character(at: index)) else { return nil }
        index = consumeWhitespace(in: line, from: index)
        if index + 2 < line.length,
           line.character(at: index) == 91,
           line.character(at: index + 2) == 93,
           [32, 120, 88].contains(line.character(at: index + 1)) {
            let afterTask = index + 3
            if afterTask < line.length, isWhitespace(line.character(at: afterTask)) {
                index = consumeWhitespace(in: line, from: afterTask)
            }
        }
        return NSRange(location: start, length: index - start)
    }

    private static func headingPrefixRange(in line: NSString, at start: Int) -> NSRange? {
        var index = start
        while index < line.length, index - start < 6, line.character(at: index) == 35 {
            index += 1
        }
        guard index > start, index < line.length, isWhitespace(line.character(at: index)) else {
            return nil
        }
        index = consumeWhitespace(in: line, from: index)
        return NSRange(location: start, length: index - start)
    }

    private static func consumeWhitespace(in line: NSString, from start: Int) -> Int {
        var index = start
        while index < line.length, isWhitespace(line.character(at: index)) { index += 1 }
        return index
    }

    private static func isWhitespace(_ character: unichar) -> Bool {
        character == 32 || character == 9
    }

    private static func isDigit(_ character: unichar) -> Bool {
        character >= 48 && character <= 57
    }

    private static func mapPosition(_ position: Int, through changes: [PrefixChange]) -> Int {
        var delta = 0
        for change in changes {
            let start = change.range.location
            let end = NSMaxRange(change.range)
            let replacementLength = (change.replacement as NSString).length
            if position < start { break }
            if position <= end {
                return start + delta + replacementLength
            }
            delta += replacementLength - change.range.length
        }
        return position + delta
    }

    private static func replaceSelectedLines(
        markdown: NSString,
        selection: NSRange,
        replacement: String
    ) -> RectoCommandEdit {
        let lineRange = markdown.lineRange(for: selection)
        let selectedLine = markdown.substring(with: lineRange)
        let lineEnding: String
        if selectedLine.hasSuffix("\r\n") { lineEnding = "\r\n" }
        else if selectedLine.hasSuffix("\n") { lineEnding = "\n" }
        else if selectedLine.hasSuffix("\r") { lineEnding = "\r" }
        else { lineEnding = "" }
        let value = replacement + lineEnding
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: lineRange, replacement: value),
            selection: NSRange(location: lineRange.location + (replacement as NSString).length, length: 0)
        )
    }

    private static func blockEdit(
        markdown: NSString,
        selection: NSRange,
        replacement: String,
        innerSelection: NSRange,
        generatedLineEndingRanges: [NSRange]
    ) -> RectoCommandEdit {
        let leadingBoundary = blockBoundary(before: selection.location, in: markdown)
        let trailingBoundary = blockBoundary(after: NSMaxRange(selection), in: markdown)
        let leadingLength = (leadingBoundary as NSString).length
        let replacementLength = (replacement as NSString).length
        var ranges = generatedLineEndingRanges.map {
            NSRange(location: leadingLength + $0.location, length: $0.length)
        }
        if leadingLength > 0 { ranges.append(NSRange(location: 0, length: leadingLength)) }
        if !trailingBoundary.isEmpty {
            ranges.append(NSRange(
                location: leadingLength + replacementLength,
                length: (trailingBoundary as NSString).length
            ))
        }
        return RectoCommandEdit(
            patch: MarkdownTextPatch(
                range: selection,
                replacement: leadingBoundary + replacement + trailingBoundary
            ),
            selection: NSRange(
                location: selection.location + leadingLength + innerSelection.location,
                length: innerSelection.length
            ),
            generatedLineEndingRanges: ranges
        )
    }

    private static func blockSeparator(after value: String) -> String {
        let source = value as NSString
        guard source.length > 0 else { return "" }
        return blockBoundary(before: source.length, in: source)
    }

    private static func blockBoundary(before location: Int, in source: NSString) -> String {
        guard location > 0 else { return "" }
        var index = location
        var count = 0
        while index > 0, count < 2 {
            if source.character(at: index - 1) == 10 {
                index -= 1
                if index > 0, source.character(at: index - 1) == 13 { index -= 1 }
            } else if source.character(at: index - 1) == 13 {
                index -= 1
            } else {
                break
            }
            count += 1
        }
        return String(repeating: "\n", count: 2 - count)
    }

    private static func blockBoundary(after location: Int, in source: NSString) -> String {
        guard location < source.length else { return "" }
        var index = location
        var count = 0
        while index < source.length, count < 2 {
            if source.character(at: index) == 13 {
                index += 1
                if index < source.length, source.character(at: index) == 10 { index += 1 }
            } else if source.character(at: index) == 10 {
                index += 1
            } else {
                break
            }
            count += 1
        }
        return String(repeating: "\n", count: 2 - count)
    }
}
