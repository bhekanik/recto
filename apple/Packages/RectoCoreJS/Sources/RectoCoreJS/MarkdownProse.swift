import Foundation

/// A markdown scanner that answers the two questions the typing path asks:
/// where the headings are, and what the prose is.
///
/// It is not a markdown parser and must never become the editing path. The
/// engine in `RectoEditor` and the JS core own that. It exists because a
/// whole-document `RectoCore` call costs ~10 ms per kB on a Mac (plan 023 §1.5)
/// and more on iOS, which cannot run on every keystroke.
///
/// ## Contracts it models
///
/// `lib/markdown/count-words.ts` walks the MDAST, collects every `text` node's
/// value, joins them with a **single space**, and splits on `\s+`.
/// `lib/outline/extract.ts` walks `heading` nodes and reports `depth`, the
/// flattened child text, and `position.start.offset`.
///
/// The scanner models those results by emitting text-node characters and one
/// space for syntax or non-text nodes. It agrees with the JS core on every
/// document in the differential gate. That is a tested boundary, not a claim
/// that this scanner implements all of CommonMark or remark.
///
/// ## Where it is checked
///
/// `SwiftPortTests` runs fixtures and the shared corpus. The seeded differential
/// gate adds 256 mixed documents and calls `RectoCore.countWords` and
/// `RectoCore.parseOutline` for each one. The JS core remains the authority and
/// corrects the typing-path values at document boundaries. Any divergence found
/// in a real document belongs in that gate before this scanner changes.
///
/// ## Known approximations
///
/// The block and link-definition grammars cover the tested forms rather than a
/// full micromark state machine. Named character references use the common prose
/// subset documented beside the table; numeric references are complete.
/// Multiline inline HTML tags are not implemented. MDX, math, and directive
/// extensions are also omitted because Recto's canonical parser does not enable
/// them.
enum MarkdownProse {
    /// JavaScript's `\s` character class, exactly.
    ///
    /// Not `CharacterSet.whitespacesAndNewlines`, which includes U+200B ZERO
    /// WIDTH SPACE — JavaScript does not, so a corpus case with a zero-width
    /// space would count one word here and two on the web.
    static func isJSWhitespace(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
            0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// The prose of `markdown`: `text`-node characters, one space for everything
    /// else. Whitespace is not collapsed — the caller splits.
    static func extract(from markdown: String) -> String {
        Walker(markdown: markdown).run().prose
    }

    /// Headings in document order, with UTF-16 offsets into `markdown`.
    static func headings(in markdown: String) -> [OutlineHeading] {
        Walker(markdown: markdown).run().headings
    }
}
