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
        let semanticSpans = RectoMarkdownContext.semanticSpans(
            in: source,
            intersecting: selection
        )
        if let code = enclosingCodeContext(
            in: semanticSpans,
            selection: selection,
            documentLength: source.length
        ) {
            switch (command, code.kind) {
            case (.inlineCode, .inlineCode), (.codeBlock, .codeBlock):
                break
            default:
                return nil
            }
        }

        switch command {
        case .bold:
            return inline(markdown: source, selection: selection, delimiter: "**", placeholder: "text", semanticSpans: semanticSpans)
        case .italic:
            return inline(markdown: source, selection: selection, delimiter: "_", placeholder: "text", semanticSpans: semanticSpans)
        case .strikethrough:
            return inline(markdown: source, selection: selection, delimiter: "~~", placeholder: "text", semanticSpans: semanticSpans)
        case .inlineCode:
            return codeSpan(markdown: source, selection: selection, semanticSpans: semanticSpans)
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
        return RectoMarkdownContext.semanticSpans(
            in: source,
            intersecting: selection
        ).reduce(into: Set()) { active, span in
            guard contains(span.contentRange, selection) else { return }
            switch span.kind {
            case .emphasis(.bold):
                active.insert(.bold)
            case .emphasis(.italic):
                active.insert(.italic)
            case .emphasis(.boldItalic):
                active.formUnion([.bold, .italic])
            case .inlineCode:
                active.insert(.inlineCode)
            case .inlineExtension(StrikethroughExtension.identifier):
                active.insert(.strikethrough)
            case .codeBlock, .blockExtension, .inlineExtension:
                break
            }
        }
    }

    private static func inline(
        markdown: NSString,
        selection: NSRange,
        delimiter: String,
        placeholder: String,
        semanticSpans: [MarkdownSemanticSpan]
    ) -> RectoCommandEdit? {
        if selection.length > 0,
            let wrapper = enclosingInlineSpan(
               in: semanticSpans,
               selection: selection,
               delimiter: delimiter
           ) {
            let nested = nestedSpansContainingSelection(
                in: semanticSpans,
                wrapper: wrapper,
                selection: selection
            )
            if !nested.isEmpty {
                return removingInlineMark(
                    in: markdown,
                    wrapper: wrapper,
                    nested: nested,
                    selection: selection,
                    removing: delimiter
                )
            }
            let contentStart = wrapper.contentRange.location
            let contentEnd = NSMaxRange(wrapper.contentRange)
            let prefix = markdown.substring(with: NSRange(
                location: contentStart,
                length: selection.location - contentStart
            ))
            let selected = markdown.substring(with: selection)
            let suffix = markdown.substring(with: NSRange(
                location: NSMaxRange(selection),
                length: contentEnd - NSMaxRange(selection)
            ))
            let fragmentDelimiter = fragmentDelimiter(for: wrapper, in: markdown)
            let markedPrefix = markedFragment(prefix, delimiter: fragmentDelimiter)
            let markedSuffix = markedFragment(suffix, delimiter: fragmentDelimiter)
            let remainingDelimiter = remainingDelimiter(
                afterRemoving: delimiter,
                from: wrapper.kind
            )
            let selectedReplacement = remainingDelimiter.map {
                markedFragment(selected, delimiter: $0)
            } ?? selected
            let selectedOffset = remainingDelimiter.map {
                    insertedOpeningDelimiterLength(
                        in: selected,
                        sourceOffset: 0,
                        delimiter: $0
                    )
                } ?? 0
            return RectoCommandEdit(
                patch: MarkdownTextPatch(
                    range: wrapper.range,
                    replacement: markedPrefix + selectedReplacement + markedSuffix
                ),
                selection: NSRange(
                    location: wrapper.range.location
                        + (markedPrefix as NSString).length
                        + selectedOffset,
                    length: selection.length
                )
            )
        }

        let selected = selection.length == 0 ? placeholder : markdown.substring(with: selection)
        let selectedText = selected as NSString
        let delimiterLength = (delimiter as NSString).length
        guard let marker = delimiter.first,
              selectedText.range(of: "\n").location == NSNotFound,
              selectedText.range(of: "\r").location == NSNotFound,
              selectedText.range(of: String(marker)).location == NSNotFound else { return nil }
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

    private static func enclosingInlineSpan(
        in semanticSpans: [MarkdownSemanticSpan],
        selection: NSRange,
        delimiter: String
    ) -> MarkdownSemanticSpan? {
        semanticSpans
            .filter { span in
                guard contains(span.contentRange, selection) else { return false }
                switch (delimiter, span.kind) {
                case ("**", .emphasis(.bold)),
                     ("**", .emphasis(.boldItalic)),
                     ("_", .emphasis(.italic)),
                     ("_", .emphasis(.boldItalic)),
                     ("~~", .inlineExtension(StrikethroughExtension.identifier)):
                    return true
                default:
                    return false
                }
            }
            .min { $0.range.length < $1.range.length }
    }

    private static func enclosingCodeContext(
        in semanticSpans: [MarkdownSemanticSpan],
        selection: NSRange,
        documentLength: Int
    ) -> MarkdownSemanticSpan? {
        semanticSpans.first {
            switch $0.kind {
            case .inlineCode, .codeBlock:
                RectoMarkdownContext.intersectsCodeSpan(
                    $0,
                    range: selection,
                    documentLength: documentLength
                )
            default:
                false
            }
        }
    }

    private static func nestedSpansContainingSelection(
        in semanticSpans: [MarkdownSemanticSpan],
        wrapper: MarkdownSemanticSpan,
        selection: NSRange
    ) -> [MarkdownSemanticSpan] {
        semanticSpans
            .filter {
                $0.range != wrapper.range
                    && contains(wrapper.contentRange, $0.range)
                    && contains($0.contentRange, selection)
            }
            .sorted { $0.range.length > $1.range.length }
    }

    private static func removingInlineMark(
        in markdown: NSString,
        wrapper: MarkdownSemanticSpan,
        nested: [MarkdownSemanticSpan],
        selection: NSRange,
        removing delimiter: String
    ) -> RectoCommandEdit? {
        guard let contentSelection = trimmedSelection(selection, in: markdown) else { return nil }
        let outermost = nested[0]
        let beforeNested = markdown.substring(with: NSRange(
            location: wrapper.contentRange.location,
            length: outermost.range.location - wrapper.contentRange.location
        ))
        let nestedPrefix = nestedFragment(
            before: contentSelection,
            spans: nested,
            in: markdown
        )
        var selected = (markdown: markdown.substring(with: contentSelection), contentOffset: 0)
        for span in nested.reversed() {
            let fragment = semanticFragment(selected.markdown, span: span, in: markdown)
            selected = (
                fragment.markdown,
                selected.contentOffset + fragment.contentOffset
            )
        }
        if let remaining = remainingDelimiter(afterRemoving: delimiter, from: wrapper.kind) {
            selected = (
                markedFragment(selected.markdown, delimiter: remaining),
                selected.contentOffset + insertedOpeningDelimiterLength(
                    in: selected.markdown,
                    sourceOffset: 0,
                    delimiter: remaining
                )
            )
        }
        let nestedSuffix = nestedFragment(after: contentSelection, spans: nested, in: markdown)
        let afterNested = markdown.substring(with: NSRange(
            location: NSMaxRange(outermost.range),
            length: NSMaxRange(wrapper.contentRange) - NSMaxRange(outermost.range)
        ))
        let outerDelimiter = fragmentDelimiter(for: wrapper, in: markdown)
        let markedPrefix = markedFragment(
            beforeNested + nestedPrefix,
            delimiter: outerDelimiter
        )
        let markedSuffix = markedFragment(
            nestedSuffix + afterNested,
            delimiter: outerDelimiter
        )
        return RectoCommandEdit(
            patch: MarkdownTextPatch(
                range: wrapper.range,
                replacement: markedPrefix + selected.markdown + markedSuffix
            ),
            selection: NSRange(
                location: wrapper.range.location
                    + (markedPrefix as NSString).length
                    + selected.contentOffset,
                length: contentSelection.length
            )
        )
    }

    private static func trimmedSelection(
        _ selection: NSRange,
        in markdown: NSString
    ) -> NSRange? {
        var start = selection.location
        let selectionEnd = NSMaxRange(selection)
        while start < selectionEnd, isWhitespace(markdown.character(at: start)) {
            start += 1
        }
        var end = selectionEnd
        while end > start, isWhitespace(markdown.character(at: end - 1)) {
            end -= 1
        }
        guard start < end else { return nil }
        return NSRange(location: start, length: end - start)
    }

    private static func nestedFragment(
        before selection: NSRange,
        spans: [MarkdownSemanticSpan],
        in markdown: NSString
    ) -> String {
        var index = spans.count - 1
        var fragment = markdown.substring(with: NSRange(
            location: spans[index].contentRange.location,
            length: selection.location - spans[index].contentRange.location
        ))
        fragment = semanticFragment(fragment, span: spans[index], in: markdown).markdown
        while index > 0 {
            let child = spans[index]
            index -= 1
            let span = spans[index]
            fragment = markdown.substring(with: NSRange(
                location: span.contentRange.location,
                length: child.range.location - span.contentRange.location
            )) + fragment
            fragment = semanticFragment(fragment, span: span, in: markdown).markdown
        }
        return fragment
    }

    private static func nestedFragment(
        after selection: NSRange,
        spans: [MarkdownSemanticSpan],
        in markdown: NSString
    ) -> String {
        var index = spans.count - 1
        var fragment = markdown.substring(with: NSRange(
            location: NSMaxRange(selection),
            length: NSMaxRange(spans[index].contentRange) - NSMaxRange(selection)
        ))
        fragment = semanticFragment(fragment, span: spans[index], in: markdown).markdown
        while index > 0 {
            let child = spans[index]
            index -= 1
            let span = spans[index]
            fragment += markdown.substring(with: NSRange(
                location: NSMaxRange(child.range),
                length: NSMaxRange(span.contentRange) - NSMaxRange(child.range)
            ))
            fragment = semanticFragment(fragment, span: span, in: markdown).markdown
        }
        return fragment
    }

    private static func semanticFragment(
        _ value: String,
        span: MarkdownSemanticSpan,
        in markdown: NSString
    ) -> (markdown: String, contentOffset: Int) {
        guard !value.isEmpty else { return ("", 0) }
        if span.kind == .inlineCode {
            let delimiterLength = longestRun(of: "`", in: value) + 1
            let hasBoundarySpace = (value.hasPrefix(" ") || value.hasSuffix(" "))
                && !value.allSatisfy { $0 == " " }
            let paddingLength = value.hasPrefix("`") || value.hasSuffix("`") || hasBoundarySpace ? 1 : 0
            return (
                codeSpanMarkdown(value),
                delimiterLength + paddingLength
            )
        }
        let delimiter = span.markerRanges.first.map { markdown.substring(with: $0) } ?? ""
        return (
            markedFragment(value, delimiter: delimiter),
            insertedOpeningDelimiterLength(in: value, sourceOffset: 0, delimiter: delimiter)
        )
    }

    private static func fragmentDelimiter(
        for span: MarkdownSemanticSpan,
        in markdown: NSString
    ) -> String {
        guard let opening = span.markerRanges.first else { return "" }
        let sourceDelimiter = markdown.substring(with: opening)
        return sourceDelimiter == "_" ? "*" : sourceDelimiter
    }

    private static func remainingDelimiter(
        afterRemoving delimiter: String,
        from kind: MarkdownSemanticKind
    ) -> String? {
        guard kind == .emphasis(.boldItalic) else { return nil }
        return delimiter == "**" ? "*" : "**"
    }

    private static func markedFragment(_ value: String, delimiter: String) -> String {
        guard !value.isEmpty else { return "" }
        let source = value as NSString
        var contentStart = 0
        while contentStart < source.length, isWhitespace(source.character(at: contentStart)) {
            contentStart += 1
        }
        var contentEnd = source.length
        while contentEnd > contentStart, isWhitespace(source.character(at: contentEnd - 1)) {
            contentEnd -= 1
        }
        guard contentStart < contentEnd else { return value }
        return source.substring(to: contentStart)
            + delimiter
            + source.substring(with: NSRange(location: contentStart, length: contentEnd - contentStart))
            + delimiter
            + source.substring(from: contentEnd)
    }

    private static func insertedOpeningDelimiterLength(
        in value: String,
        sourceOffset: Int,
        delimiter: String
    ) -> Int {
        let source = value as NSString
        var contentStart = 0
        while contentStart < source.length, isWhitespace(source.character(at: contentStart)) {
            contentStart += 1
        }
        return sourceOffset >= contentStart ? (delimiter as NSString).length : 0
    }

    private static func contains(_ outer: NSRange, _ inner: NSRange) -> Bool {
        inner.location >= outer.location && NSMaxRange(inner) <= NSMaxRange(outer)
    }

    private static func codeSpan(
        markdown: NSString,
        selection: NSRange,
        semanticSpans: [MarkdownSemanticSpan]
    ) -> RectoCommandEdit {
        if selection.length > 0,
           let enclosure = semanticSpans.first(where: {
               $0.kind == .inlineCode && contains($0.contentRange, selection)
           }) {
            let prefix = markdown.substring(with: NSRange(
                location: enclosure.contentRange.location,
                length: selection.location - enclosure.contentRange.location
            ))
            let selected = markdown.substring(with: selection)
            let suffix = markdown.substring(with: NSRange(
                location: NSMaxRange(selection),
                length: NSMaxRange(enclosure.contentRange) - NSMaxRange(selection)
            ))
            let markedPrefix = prefix.isEmpty ? "" : codeSpanMarkdown(prefix)
            let markedSuffix = suffix.isEmpty ? "" : codeSpanMarkdown(suffix)
            return RectoCommandEdit(
                patch: MarkdownTextPatch(
                    range: enclosure.range,
                    replacement: markedPrefix + selected + markedSuffix
                ),
                selection: NSRange(
                    location: enclosure.range.location + (markedPrefix as NSString).length,
                    length: selection.length
                )
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

    private static func codeSpanMarkdown(_ content: String) -> String {
        let delimiter = String(repeating: "`", count: longestRun(of: "`", in: content) + 1)
        let hasBoundarySpace = (content.hasPrefix(" ") || content.hasSuffix(" "))
            && !content.allSatisfy { $0 == " " }
        let padding = content.hasPrefix("`") || content.hasSuffix("`") || hasBoundarySpace ? " " : ""
        return delimiter + padding + content + padding + delimiter
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
        let listIndentation: String
        let headingRange: NSRange?
        let isIndentedCode: Bool
    }

    private struct PrefixChange {
        let range: NSRange
        let replacement: String
    }

    private static func rewriteLines(
        markdown: NSString,
        selection: NSRange,
        command: LineCommand
    ) -> RectoCommandEdit? {
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
        guard lines.allSatisfy({
            hasSupportedIndentation($0.contents as NSString) && !$0.prefix.isIndentedCode
        }) else { return nil }

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
                    replacement: prefix + line.prefix.listIndentation
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
        var isIndentedCode = false
        while index < line.length, line.character(at: index) == 62 {
            let markerStart = index
            index += 1
            let whitespaceStart = index
            index = consumeWhitespace(in: line, from: index)
            let whitespaceLength = index - whitespaceStart
            if whitespaceLength >= 4 || (whitespaceLength > 0 && line.character(at: whitespaceStart) == 9) {
                isIndentedCode = true
            }
            if outerQuoteRange == nil {
                outerQuoteRange = NSRange(
                    location: markerStart,
                    length: 1 + min(whitespaceLength, 1)
                )
            }
        }
        let quoteRange = index > quoteStart
            ? NSRange(location: quoteStart, length: index - quoteStart)
            : nil
        let containerEnd = index
        let listRange = listPrefixRange(in: line, at: index)
        let listIndentation: String
        if let listRange {
            var whitespaceStart = NSMaxRange(listRange)
            while whitespaceStart > listRange.location,
                  isWhitespace(line.character(at: whitespaceStart - 1)) {
                whitespaceStart -= 1
            }
            let whitespaceLength = NSMaxRange(listRange) - whitespaceStart
            if whitespaceLength >= 4 || (whitespaceLength > 0 && line.character(at: whitespaceStart) == 9) {
                isIndentedCode = true
            }
            listIndentation = whitespaceLength > 1
                ? line.substring(with: NSRange(location: whitespaceStart + 1, length: whitespaceLength - 1))
                : ""
        } else {
            listIndentation = ""
        }
        if let listRange { index = NSMaxRange(listRange) }
        let headingRange = headingPrefixRange(in: line, at: index)
        return LinePrefix(
            indentationEnd: indentationEnd,
            quoteRange: quoteRange,
            outerQuoteRange: outerQuoteRange,
            containerEnd: containerEnd,
            listRange: listRange,
            listIndentation: listIndentation,
            headingRange: headingRange,
            isIndentedCode: isIndentedCode
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

    private static func hasSupportedIndentation(_ line: NSString) -> Bool {
        var index = 0
        while index < line.length, line.character(at: index) == 32 { index += 1 }
        return index <= 3 && (index == line.length || line.character(at: index) != 9)
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
