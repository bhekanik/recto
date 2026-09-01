import Foundation
import MarkdownEngine

public enum RectoSlashInsertion: Equatable, Sendable {
    case heading(level: Int)
    case text(String)
    case bulletList
    case orderedList
    case blockquote
    case codeBlock(language: String)
    case divider
    case table(rows: Int, columns: Int)
}

public struct RectoSlashEntry: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let aliases: [String]
    public let insertion: RectoSlashInsertion

    public init(
        id: String,
        label: String,
        aliases: [String],
        insertion: RectoSlashInsertion
    ) {
        self.id = id
        self.label = label
        self.aliases = aliases
        self.insertion = insertion
    }
}

public struct RectoSlashMenuState: Equatable, Sendable {
    public let query: String
    public let queryRange: NSRange
    public let entries: [RectoSlashEntry]
    public let selectedIndex: Int
    public let anchorRect: CGRect?

    public var selectedEntry: RectoSlashEntry? {
        entries.indices.contains(selectedIndex) ? entries[selectedIndex] : nil
    }

    public init(
        query: String,
        queryRange: NSRange,
        entries: [RectoSlashEntry],
        selectedIndex: Int,
        anchorRect: CGRect?
    ) {
        self.query = query
        self.queryRange = queryRange
        self.entries = entries
        self.selectedIndex = selectedIndex
        self.anchorRect = anchorRect
    }
}

public enum RectoSlashMenu {
    public static let entries: [RectoSlashEntry] = [
        RectoSlashEntry(id: "h1", label: "Heading 1", aliases: ["h1", "title"], insertion: .heading(level: 1)),
        RectoSlashEntry(id: "h2", label: "Heading 2", aliases: ["h2", "subtitle"], insertion: .heading(level: 2)),
        RectoSlashEntry(id: "h3", label: "Heading 3", aliases: ["h3"], insertion: .heading(level: 3)),
        RectoSlashEntry(id: "bold", label: "Bold", aliases: ["b", "strong"], insertion: .text("**text**")),
        RectoSlashEntry(id: "italic", label: "Italic", aliases: ["i", "em", "emphasis"], insertion: .text("_text_")),
        RectoSlashEntry(id: "strike", label: "Strikethrough", aliases: ["strike", "del", "s"], insertion: .text("~~text~~")),
        RectoSlashEntry(id: "code", label: "Inline code", aliases: ["code", "mono"], insertion: .text("`code`")),
        RectoSlashEntry(id: "bullet", label: "Bullet list", aliases: ["ul", "unordered", "list"], insertion: .bulletList),
        RectoSlashEntry(id: "ordered", label: "Numbered list", aliases: ["ol", "ordered", "number"], insertion: .orderedList),
        RectoSlashEntry(id: "task", label: "Task list", aliases: ["todo", "checkbox", "check"], insertion: .text("- [ ] ")),
        RectoSlashEntry(id: "quote", label: "Blockquote", aliases: ["quote", "bq"], insertion: .blockquote),
        RectoSlashEntry(id: "fence", label: "Code block", aliases: ["pre", "fence", "codeblock"], insertion: .codeBlock(language: "")),
        RectoSlashEntry(id: "divider", label: "Divider", aliases: ["hr", "rule", "separator"], insertion: .divider),
        RectoSlashEntry(id: "table", label: "Table", aliases: ["tbl", "grid"], insertion: .table(rows: 2, columns: 2)),
        RectoSlashEntry(id: "link", label: "Link", aliases: ["url", "href", "a"], insertion: .text("[text](https://)")),
        RectoSlashEntry(id: "image", label: "Image", aliases: ["img", "picture"], insertion: .text("![alt](https://)")),
        RectoSlashEntry(id: "footnote", label: "Footnote", aliases: ["fn", "note", "ref"], insertion: .text("[^1]\n\n[^1]: Footnote text")),
    ]

    public static func filteredEntries(query: String) -> [RectoSlashEntry] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return entries }
        return entries.filter { entry in
            entry.label.lowercased().contains(query)
                || entry.aliases.contains { $0.contains(query) || query.contains($0) }
        }
    }

    static func state(
        markdown: String,
        selection: NSRange,
        selectedIndex: Int,
        anchorRect: CGRect?
    ) -> RectoSlashMenuState? {
        guard selection.length == 0 else { return nil }
        let source = markdown as NSString
        guard selection.location <= source.length else { return nil }
        let prefixRange = source.lineRange(for: NSRange(location: selection.location, length: 0))
        let beforeCaretLength = selection.location - prefixRange.location
        guard beforeCaretLength >= 1 else { return nil }
        let beforeCaret = source.substring(with: NSRange(
            location: prefixRange.location,
            length: beforeCaretLength
        ))
        guard let slash = beforeCaret.lastIndex(of: "/") else { return nil }
        let beforeSlash = beforeCaret[..<slash]
        guard beforeSlash.allSatisfy({ $0 == " " || $0 == "\t" }) else { return nil }
        let query = String(beforeCaret[beforeCaret.index(after: slash)...])
        guard query.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == " " }) else {
            return nil
        }
        let entries = filteredEntries(query: query)
        let slashOffset = (String(beforeSlash) as NSString).length
        let range = NSRange(
            location: prefixRange.location + slashOffset,
            length: (String(beforeCaret[slash...]) as NSString).length
        )
        return RectoSlashMenuState(
            query: query,
            queryRange: range,
            entries: entries,
            selectedIndex: entries.isEmpty ? 0 : min(selectedIndex, entries.count - 1),
            anchorRect: anchorRect
        )
    }

    static func edit(entry: RectoSlashEntry, queryRange: NSRange) -> RectoCommandEdit {
        let replacement: String
        let selectionOffset: Int
        let selectionLength: Int
        switch entry.insertion {
        case let .heading(level):
            replacement = String(repeating: "#", count: level) + " "
            selectionOffset = (replacement as NSString).length
            selectionLength = 0
        case let .text(text):
            replacement = text
            let placeholder: String
            if text.hasPrefix("**") { placeholder = "text" }
            else if text.hasPrefix("_") { placeholder = "text" }
            else if text.hasPrefix("~~") { placeholder = "text" }
            else if text.hasPrefix("`") { placeholder = "code" }
            else if text.hasPrefix("[text]") { placeholder = "text" }
            else if text.hasPrefix("![alt]") { placeholder = "alt" }
            else if text.hasPrefix("[^1]") { placeholder = "Footnote text" }
            else { placeholder = "" }
            let found = (text as NSString).range(of: placeholder)
            selectionOffset = found.location == NSNotFound ? (text as NSString).length : found.location
            selectionLength = found.location == NSNotFound ? 0 : found.length
        case .bulletList:
            replacement = "- "
            selectionOffset = 2
            selectionLength = 0
        case .orderedList:
            replacement = "1. "
            selectionOffset = 3
            selectionLength = 0
        case .blockquote:
            replacement = "> "
            selectionOffset = 2
            selectionLength = 0
        case let .codeBlock(language):
            replacement = "```\(language)\n\n```"
            selectionOffset = ("```\(language)\n" as NSString).length
            selectionLength = 0
        case .divider:
            replacement = "---"
            selectionOffset = 3
            selectionLength = 0
        case let .table(rows, columns):
            let header = "| " + Array(repeating: "Header", count: columns).joined(separator: " | ") + " |"
            let separator = "| " + Array(repeating: "---", count: columns).joined(separator: " | ") + " |"
            let body = Array(repeating: "| " + Array(repeating: "Cell", count: columns).joined(separator: " | ") + " |", count: max(0, rows - 1))
            replacement = ([header, separator] + body).joined(separator: "\n")
            selectionOffset = 2
            selectionLength = 6
        }
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: queryRange, replacement: replacement),
            selection: NSRange(location: queryRange.location + selectionOffset, length: selectionLength)
        )
    }
}
