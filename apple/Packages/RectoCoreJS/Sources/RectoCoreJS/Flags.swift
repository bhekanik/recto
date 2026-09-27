import Foundation

/// The writing-flag edits of `lib/markdown/flags.ts`: the token, the
/// line-start guard and the string splices, on UTF-16 offsets. Finding flags
/// needs a Markdown parse (flags in code are text), so that stays with the
/// authority, `RectoCore.findFlags`; these run on its results and at the caret.
/// `flags.json` holds both implementations to the same answers.
public enum Flags {
    public static let open = "<!--flag"
    public static let close = "-->"
    /// U+2060 WORD JOINER in front of a flag that would begin a line: a line
    /// starting `<!--` opens an HTML block and swallows the rest of the line.
    public static let guardCharacter = "\u{2060}"

    /// One line, and no `--` that could close the comment early.
    public static func clean(_ note: String) -> String {
        var clean = note.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        clean = clean.replacingOccurrences(of: "-{2,}", with: "–", options: .regularExpression)
        if clean.hasSuffix("-") { clean = String(clean.dropLast()) + "–" }
        return clean
    }

    /// `<!--flag: note-->`, or `<!--flag-->` without a note.
    public static func token(_ note: String) -> String {
        let clean = clean(note)
        return clean.isEmpty ? open + close : "\(open): \(clean)\(close)"
    }

    private static let blockPrefix = try! NSRegularExpression(
        pattern: #"^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*(?:\[[ xX]\][ \t]*)?$"#)

    /// Whether a flag at `at` would begin its line's content.
    public static func needsGuard(in markdown: String, at: Int) -> Bool {
        let text = markdown as NSString
        let at = max(0, min(at, text.length))
        let before = text.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: at))
        let lineStart = before.location == NSNotFound ? 0 : NSMaxRange(before)
        let prefix = text.substring(with: NSRange(location: lineStart, length: at - lineStart))
        let range = NSRange(location: 0, length: (prefix as NSString).length)
        return blockPrefix.firstMatch(in: prefix, range: range) != nil
    }

    /// The text a new flag at `at` inserts, guard included when needed.
    public static func insertion(in markdown: String, at: Int, note: String = "") -> String {
        needsGuard(in: markdown, at: at) ? guardCharacter + token(note) : token(note)
    }

    /// `markdown` with `flag`'s note replaced.
    public static func settingNote(_ note: String, of flag: WritingFlag, in markdown: String) -> String {
        (markdown as NSString).replacingCharacters(
            in: NSRange(location: flag.tokenFrom, length: flag.to - flag.tokenFrom), with: token(note))
    }

    /// The range resolving `flag` removes: the flag, its guard, and one of
    /// the spaces around it when it sits between two.
    public static func removalRange(of flag: WritingFlag, in markdown: String) -> NSRange {
        let text = markdown as NSString
        let space: unichar = 0x20
        let spaced = flag.from > 0 && flag.to < text.length
            && text.character(at: flag.from - 1) == space && text.character(at: flag.to) == space
        return NSRange(location: flag.from, length: flag.to - flag.from + (spaced ? 1 : 0))
    }

    /// `markdown` with `flag` resolved (removed).
    public static func removing(_ flag: WritingFlag, from markdown: String) -> String {
        (markdown as NSString).replacingCharacters(in: removalRange(of: flag, in: markdown), with: "")
    }
}
