import Foundation

/// Prose word count, matching `lib/markdown/count-words.ts` exactly.
///
/// The web counts words by walking the MDAST and joining every `text` node's
/// value with a single space, then splitting on whitespace. `MarkdownProse`
/// reproduces that segmentation without building a tree; the contract and the
/// gaps are documented there.
///
/// This is the typing-path count. `RectoCore.countWords` is the authority and
/// runs at document boundaries; `SwiftPortTests` asserts the two agree on every
/// corpus case, so a divergence is a test failure rather than a wrong number in
/// the status bar.
public enum WordCount {
    /// Words in the prose of `markdown` — markdown syntax, code and URLs excluded.
    public static func count(_ markdown: String) -> Int {
        countPlainText(MarkdownProse.extract(from: markdown))
    }

    /// Words in already-plain text: collapse whitespace, ignore empty tokens.
    ///
    /// Split on Unicode whitespace rather than on `" "`, because the corpus
    /// carries NBSP and zero-width space and remark's `\s+` treats NBSP as
    /// whitespace and ZWSP as part of a word.
    public static func countPlainText(_ text: String) -> Int {
        var words = 0
        var inWord = false
        for scalar in text.unicodeScalars {
            if MarkdownProse.isJSWhitespace(scalar) {
                inWord = false
            } else if !inWord {
                inWord = true
                words += 1
            }
        }
        return words
    }
}
