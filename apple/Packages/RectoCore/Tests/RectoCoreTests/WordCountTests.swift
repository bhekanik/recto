import Testing

@testable import RectoCore

/// `RectoWordCount.plainText` against what `countWordsFromPlainText` in
/// `lib/markdown/count-words.ts` returns for the same input (`split(/\s+/)`).
@Suite("plain-text word count")
struct WordCountTests {
    @Test("runs of non-space, however they are separated", arguments: [
        ("", 0),
        ("   \n\t ", 0),
        ("one", 1),
        ("  one  two\n\nthree\t", 3),
        ("# Heading\n\n- item **bold**", 5),
        ("naïve café 😀 x", 4),
    ])
    func counts(_ text: String, _ expected: Int) {
        #expect(RectoWordCount.plainText(text) == expected)
    }

    @Test("JavaScript's \\s, not Swift's or Unicode's whitespace")
    func javaScriptWhitespace() {
        // NBSP, the ideographic space and U+FEFF separate words in JS…
        #expect(RectoWordCount.plainText("a\u{00A0}b\u{3000}c\u{FEFF}d") == 4)
        // …U+0085 (NEL) does not, though Swift and Unicode call it whitespace.
        #expect(RectoWordCount.plainText("a\u{0085}b") == 1)
        // A combining mark after a space starts a word for a JS regex, which
        // sees code points; grapheme-based splitting would fold it into the space.
        #expect(RectoWordCount.plainText("a \u{0301}b") == 2)
    }
}
