import Foundation

/// Fast typing-path model of `lib/markdown/count-words.ts`.
///
/// The web counts words by walking the MDAST and joining every `text` node's
/// value with a single space, then splitting on whitespace. `MarkdownProse`
/// models that segmentation without building a tree. It matches the JS core on
/// the fixture, adversarial, and 256-document differential gates.
///
/// This is the typing-path count. `RectoCore.countWords` is the authority and
/// runs at document boundaries and corrects this value there. A divergence from
/// a real document is a new differential case, not evidence that this scanner
/// has the full remark grammar. `MarkdownProse` lists the omitted constructs.
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
