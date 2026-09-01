import Foundation
import JavaScriptCore

/// Title derivation for local editor writes.
public enum MarkdownTitle {
    private static let yamlTitleParser = JavaScriptYamlTitleParser()

    public static func derive(_ markdown: String) -> String {
        let frontmatter = leadingFrontmatter(markdown)
        if let title = frontmatter.title, !title.isEmpty { return title }

        let body: String
        if frontmatter.bodyOffset > 0 {
            body = (markdown as NSString).substring(from: frontmatter.bodyOffset)
        } else {
            let trimmed = trimJSWhitespaceStart(markdown)
            let reparsed = leadingFrontmatter(trimmed)
            body = reparsed.bodyOffset > 0
                ? (trimmed as NSString).substring(from: reparsed.bodyOffset)
                : trimmed
        }
        if let heading = Outline.parse(body).first(where: { !$0.text.isEmpty }) {
            return heading.text
        }

        if let paragraph = MarkdownProse.firstParagraph(in: body) {
            let text = normalizedParagraph(paragraph)
            if !text.isEmpty { return text }
        }
        return "Untitled"
    }

    private static func normalizedParagraph(_ value: String) -> String {
        trimJSWhitespace(value.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        )
    }

    private static func leadingFrontmatter(_ markdown: String) -> (title: String?, bodyOffset: Int) {
        let ns = markdown as NSString
        guard ns.length >= 4 else { return (nil, 0) }
        let firstLine = ns.lineRange(for: NSRange(location: 0, length: 0))
        var opening = lineContent(ns, firstLine)
        if opening.first == "\u{FEFF}" { opening.removeFirst() }
        guard isDelimiter(opening) else { return (nil, 0) }

        var cursor = NSMaxRange(firstLine)
        while cursor < ns.length {
            let lineRange = ns.lineRange(for: NSRange(location: cursor, length: 0))
            if isDelimiter(lineContent(ns, lineRange)) {
                let yamlRange = NSRange(
                    location: NSMaxRange(firstLine),
                    length: lineRange.location - NSMaxRange(firstLine))
                let title = yamlTitle(ns.substring(with: yamlRange))
                return (title, NSMaxRange(lineRange))
            }
            let next = NSMaxRange(lineRange)
            guard next > cursor else { break }
            cursor = next
        }
        return (nil, 0)
    }

    private static func lineContent(_ value: NSString, _ range: NSRange) -> String {
        value.substring(with: range).trimmingCharacters(in: .newlines)
    }

    private static func isDelimiter(_ line: String) -> Bool {
        guard line.hasPrefix("---") else { return false }
        return line.dropFirst(3).allSatisfy { $0 == " " || $0 == "\t" }
    }

    private static func yamlTitle(_ yaml: String) -> String? {
        yamlTitleParser.title(in: yaml).map(trimJSWhitespace)
    }

    private static func trimJSWhitespaceStart(_ value: String) -> String {
        let start = value.unicodeScalars.drop(while: MarkdownProse.isJSWhitespace).startIndex
        return String(value.unicodeScalars[start...])
    }

}

/// `JSContext` is not Sendable; every access is serialized by `lock`.
private final class JavaScriptYamlTitleParser: @unchecked Sendable {
    private let lock = NSLock()
    private let parseTitle: JSValue

    init() {
        guard let url = Bundle.module.url(
            forResource: "js-yaml.min", withExtension: "js", subdirectory: "JS"),
            let source = try? String(contentsOf: url, encoding: .utf8),
            let context = JSContext()
        else {
            preconditionFailure("the bundled js-yaml parser must be readable")
        }
        context.evaluateScript(source, withSourceURL: url)
        guard context.exception == nil,
              let parseTitle = context.evaluateScript(
                #"""
                yaml => {
                  try {
                    const document = jsyaml.load(yaml);
                    if (!document || typeof document !== "object" || Array.isArray(document)) return null;
                    const activeArrays = new WeakSet();
                    const stringify = value => {
                      if (typeof value === "string") return value;
                      if (value == null) return "";
                      if (value instanceof Date) return value.toISOString();
                      if (!Array.isArray(value)) return String(value);
                      if (activeArrays.has(value)) return "";
                      activeArrays.add(value);
                      try { return value.map(stringify).join(","); }
                      finally { activeArrays.delete(value); }
                    };
                    return stringify(document.title);
                  } catch { return null; }
                }
                """#), context.exception == nil
        else {
            preconditionFailure("the bundled js-yaml parser must expose jsyaml.load")
        }
        self.parseTitle = parseTitle
    }

    func title(in yaml: String) -> String? {
        lock.withLock {
            guard let value = parseTitle.call(withArguments: [yaml]), !value.isNull,
                  !value.isUndefined else { return nil }
            return value.toString()
        }
    }
}
