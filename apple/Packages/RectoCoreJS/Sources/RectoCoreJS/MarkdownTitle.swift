import Foundation
import JavaScriptCore
import Yams

/// Title derivation for local editor writes.
public enum MarkdownTitle {
    private static let javascriptScalar = JavaScriptScalarConverter()
    // Yams accepts YAML 1.1 octals and numeric separators. Recto's web parser
    // uses these narrower js-yaml 4.2 bool, int, and float resolvers.
    private static let yamlResolver: Resolver = {
        do {
            return try Resolver.default
                .replacing(.bool, with: "^(?:true|True|TRUE|false|False|FALSE)$")
                .replacing(
                    .int,
                    with: "^(?:[-+]?0b[01]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$"
                )
                .replacing(
                    .float,
                    with: "^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
                )
        } catch {
            preconditionFailure("static YAML resolver patterns must compile: \(error)")
        }
    }()

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
        var scalars = Constructor.defaultScalarMap
        // Yams constructs fixed-width integers and accepts floating-point
        // overflow. js-yaml constructs both through a finite Number check.
        scalars[.int] = { scalar in javascriptScalar.number(scalar.string) }
        scalars[.float] = { scalar in javascriptScalar.number(scalar.string) }
        scalars[.timestamp] = { scalar in javascriptScalar.date(scalar.string) }
        let constructor = Constructor(scalars)
        guard let mapping = try? load(yaml: yaml, yamlResolver, constructor) as? [String: Any],
              let value = mapping["title"], !(value is NSNull)
        else { return nil }
        return trimJSWhitespace(javascriptString(value))
    }

    private static func trimJSWhitespaceStart(_ value: String) -> String {
        let start = value.unicodeScalars.drop(while: MarkdownProse.isJSWhitespace).startIndex
        return String(value.unicodeScalars[start...])
    }

    private static func javascriptString(_ value: Any) -> String {
        switch value {
        case let value as String:
            value
        case let value as Bool:
            value ? "true" : "false"
        case let value as Int:
            javascriptScalar.string(Double(value))
        case let value as Double:
            javascriptScalar.string(value)
        case let value as [Any]:
            value.map { $0 is NSNull ? "" : javascriptString($0) }.joined(separator: ",")
        case _ as [AnyHashable: Any]:
            "[object Object]"
        default:
            String(describing: value)
        }
    }

}

/// `JSContext` is not Sendable; every access is serialized by `lock`.
private final class JavaScriptScalarConverter: @unchecked Sendable {
    private let lock = NSLock()
    private let context: JSContext
    private let parseNumber: JSValue
    private let stringifyTimestamp: JSValue

    init() {
        guard let context = JSContext(),
              let parseNumber = context.evaluateScript(
                "value => { const negative = value[0] === '-'; const unsigned = '+-'.includes(value[0]) ? value.slice(1) : value; return (negative ? -1 : 1) * Number(unsigned); }"),
              let stringifyTimestamp = context.evaluateScript(
                #"""
                value => {
                  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
                  const match = date ?? /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d*))?(?:[ \t]*(Z|([-+])(\d{1,2})(?::(\d{2}))?))?$/.exec(value);
                  if (!match[4]) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).toISOString();
                  const fraction = (match[7] ?? "0").slice(0, 3).padEnd(3, "0");
                  let time = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +fraction);
                  if (match[9]) {
                    let delta = (+match[10] * 60 + +(match[11] ?? 0)) * 60000;
                    if (match[9] === "-") delta = -delta;
                    time -= delta;
                  }
                  return new Date(time).toISOString();
                }
                """#)
        else {
            preconditionFailure("JavaScriptCore must provide a context for Number formatting")
        }
        self.context = context
        self.parseNumber = parseNumber
        self.stringifyTimestamp = stringifyTimestamp
    }

    func number(_ yamlNumber: String) -> Double? {
        lock.withLock {
            switch yamlNumber.lowercased() {
            case ".inf", "+.inf": return .infinity
            case "-.inf": return -.infinity
            case ".nan": return .nan
            default:
                let value = parseNumber.call(withArguments: [yamlNumber]).toDouble()
                return value.isFinite ? value : nil
            }
        }
    }

    func string(_ value: Double) -> String {
        lock.withLock {
            JSValue(double: value, in: context).toString()
        }
    }

    func date(_ yamlTimestamp: String) -> String {
        lock.withLock {
            stringifyTimestamp.call(withArguments: [yamlTimestamp]).toString()
        }
    }
}
