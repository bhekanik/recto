import Foundation

/// A markdown scanner that answers the two questions the typing path asks:
/// where the headings are, and what the prose is.
///
/// It is **not** a markdown parser and must never become the editing path — the
/// engine in `RectoEditor` and the JS core own that. It exists because a
/// whole-document `RectoCore` call costs ~10 ms per kB on a Mac (plan 023 §1.5)
/// and more on iOS, which cannot run on every keystroke.
///
/// ## The contract it reproduces
///
/// `lib/markdown/count-words.ts` walks the MDAST, collects every `text` node's
/// value, joins them with a **single space**, and splits on `\s+`.
/// `lib/outline/extract.ts` walks `heading` nodes and reports `depth`, the
/// flattened child text, and `position.start.offset`.
///
/// So the rule this scanner follows is: emit the characters of every `text`
/// node, and emit **one space in place of everything else** — syntax, code
/// spans, images, footnote references, raw HTML, URLs. That reproduces remark's
/// join without building a tree, because two adjacent `text` nodes are always
/// separated by a non-text node.
///
/// ## Where it is checked
///
/// `SwiftPortTests` runs it against `word-count.json`, `outline.json`, the 24
/// corpus cases and the 10 unicode cases, and — when the bundle is built — against
/// `RectoCore.countWords`/`parseOutline` themselves. A divergence is a red test,
/// not a wrong number in a status bar.
///
/// ## Known approximations
///
/// Documented in `apple/Packages/README.md`. The short version: link reference
/// definitions are recognised by shape rather than resolved, HTML blocks
/// implement CommonMark types 1, 2, 6 and 7 only, and there is no support for
/// the constructs the Recto dialect does not have (setext is supported because
/// the corpus has it; `it`/`at` tag objects and MDX are not).
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
