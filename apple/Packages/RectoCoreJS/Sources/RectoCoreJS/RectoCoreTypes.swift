import Foundation

/// One heading, in document order.
///
/// `offset` is a **UTF-16 code-unit** index into the markdown the outline was
/// parsed from — the same units `NSRange` and `NSTextContentStorage` use, so it
/// drops into a text view with no conversion. `String.Index` arithmetic on
/// `Character` counts is the wrong tool: an emoji heading would shift every
/// offset after it.
public struct OutlineHeading: Sendable, Equatable, Codable {
    /// Heading level, 1–6.
    public let depth: Int
    /// Heading text with markdown syntax stripped, trimmed.
    public let text: String
    /// UTF-16 offset of the heading's first character.
    public let offset: Int
    /// 0-based position in document order; stable when two headings share text.
    public let index: Int

    public init(depth: Int, text: String, offset: Int, index: Int) {
        self.depth = depth
        self.text = text
        self.offset = offset
        self.index = index
    }
}

/// One prose-lint finding. `from`/`to` are UTF-16 offsets into the markdown.
public struct LintIssue: Sendable, Equatable, Codable {
    public let from: Int
    public let to: Int
    /// One of `passive`, `readability`, `adverb`, `weasel`.
    public let category: String
    public let message: String
    /// The offending span, as the linter saw it.
    public let text: String

    public init(from: Int, to: Int, category: String, message: String, text: String) {
        self.from = from
        self.to = to
        self.category = category
        self.message = message
        self.text = text
    }
}

/// One day's writing total. `date` is a local calendar key, `"YYYY-MM-DD"`.
public struct WritingDay: Sendable, Equatable, Codable {
    public let date: String
    public let words: Int

    public init(date: String, words: Int) {
        self.date = date
        self.words = words
    }
}

/// Lint categories, as `lib/lint/analyze.ts` names them.
public enum LintCategory: String, Sendable, CaseIterable, Codable {
    case passive
    case readability
    case adverb
    case weasel
}

public enum RectoCoreError: Error, CustomStringConvertible {
    /// `Resources/recto-core.js` is not in the bundle.
    case bundleMissing(String)
    /// `JSContext()` returned nil, or the bundle threw while being evaluated.
    case bundleLoadFailed(String)
    /// The bundle evaluated but did not define `globalThis.RectoCore`.
    case missingGlobal
    /// A call threw inside JavaScript. The message is the JS error's own.
    case javaScript(call: String, message: String)
    /// A call returned something other than the documented type. This is a bug
    /// in the bridge or in the bundle, never bad user input.
    case unexpectedResult(call: String, detail: String)

    public var description: String {
        switch self {
        case .bundleMissing(let hint):
            return "recto-core.js is missing from the package resources. \(hint)"
        case .bundleLoadFailed(let message):
            return "loading recto-core.js failed: \(message)"
        case .missingGlobal:
            return "recto-core.js evaluated but did not define globalThis.RectoCore"
        case .javaScript(let call, let message):
            return "RectoCore.\(call) threw: \(message)"
        case .unexpectedResult(let call, let detail):
            return "RectoCore.\(call) returned \(detail)"
        }
    }
}

/// One window of a document for embedding. `charStart`/`charEnd` are UTF-16.
public struct TextChunk: Sendable, Equatable {
    public let charStart: Int
    public let charEnd: Int
    public let text: String

    public init(charStart: Int, charEnd: Int, text: String) {
        self.charStart = charStart
        self.charEnd = charEnd
        self.text = text
    }
}
