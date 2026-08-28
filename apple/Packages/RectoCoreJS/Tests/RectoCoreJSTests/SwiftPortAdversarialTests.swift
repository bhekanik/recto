import Foundation
import Testing

@testable import RectoCoreJS

/// The shared fixtures are the contract, but they were written for the web and
/// do not probe the places a hand-written scanner is most likely to diverge from
/// remark. These do, and they check against the JS core itself rather than
/// against a hand-written expectation — the core is the authority, so "agrees
/// with it" is the only claim worth making.
@Suite("Swift ports, adversarial")
struct SwiftPortAdversarialTests {
    /// Prose people actually write, plus the constructs whose MDAST shape is
    /// easy to get wrong.
    static let documents: [(name: String, markdown: String)] = [
        ("snake_case survives", "The file_name_here is not emphasis.\n"),
        ("asterisk arithmetic", "Compute 2 * 3 * 4 and stop.\n"),
        ("unpaired asterisks", "Value 2**3 is not bold.\n"),
        ("partial emphasis delimiter runs", "a**b*c a**b*c\n"),
        ("intraword asterisk emphasis", "un*frigging*believable prose\n"),
        ("nested emphasis", "**bold _and italic_ together**\n"),
        ("heading with code", "# A `code` heading\n\nBody text here.\n"),
        ("heading with a link", "# See [the docs](https://example.com)\n"),
        ("heading with emphasis", "# A **bold** heading\n"),
        ("heading with inline html", "# A <b>bold</b> heading\n"),
        ("heading with an image", "# Look ![alt text](a.png) here\n"),
        ("heading with an emoji", "# 👨‍👩‍👧‍👦 family\n\n## After\n"),
        ("setext heading", "Title\n=====\n\nSub\n---\n\nBody.\n"),
        ("closing hashes", "## Heading ##\n\nBody.\n"),
        ("indented heading", "   ### Indented\n"),
        ("crlf document", "# Title\r\n\r\nBody one two three.\r\n"),
        ("hard break with spaces", "Line one  \nLine two\n"),
        ("nested list with code", "- item one\n  ```\n  not prose\n  ```\n- item two\n"),
        ("blockquote with heading", "> # Quoted heading\n>\n> Quoted body.\n"),
        ("table with inline code", "| a | b |\n| - | - |\n| `x` | y |\n"),
        ("list marker wins over table delimiter", "a | b\n- | -\nx | y\n"),
        ("html block then prose", "<div>\nnot prose\n</div>\n\nReal prose here.\n"),
        ("inline html span", "<span>counted</span> and more\n"),
        ("script block", "<script>alert(1)</script>\n\nAfter the script.\n"),
        ("autolink", "See <https://example.com> for more.\n"),
        ("email autolink", "Write to <someone@example.com> today.\n"),
        ("reference definition", "[a link][id] here\n\n[id]: https://example.com \"T\"\n"),
        ("footnote with prose", "Body[^n] text.\n\n[^n]: The note itself.\n"),
        ("escaped brackets", "Not a link \\[^ref] but text.\n"),
        ("escaped pipe in a table", "| c |\n| - |\n| a \\| b |\n"),
        ("thematic breaks", "One\n\n***\n\nTwo\n\n___\n\nThree\n"),
        ("frontmatter then heading", "---\ntitle: X\n---\n\n# Real heading\n"),
        ("non-frontmatter dashes", "Body\n\n---\n\n# Heading after a break\n"),
        ("nbsp and zero width", "one\u{00A0}two\u{200B}three four\n"),
        ("tight list of headings", "# One\n## Two\n### Three\n"),
        ("empty heading", "#\n\n## \n\nBody.\n"),
        ("deep blockquote", "> > > deep quote text\n"),
        ("ordered list continuation", "1. first line\n   second line\n2. next\n"),
        ("task list", "- [ ] todo item\n- [x] done item\n"),
        ("strikethrough", "~~gone~~ but ~not~ this\n"),
        ("code fence with tildes", "~~~\nnot prose\n~~~\n\nAfter.\n"),
        ("indented code block", "Body.\n\n    not prose\n\nAfter.\n"),
        ("link title in parens", "[x](https://e.com \"Title Here\") end\n"),
        ("bare brackets", "An [orphan] bracket stays text.\n"),
        ("underscores around punctuation", "_(parenthesised)_ and _end_.\n"),
        // Found while documenting the scanner; each was a real divergence.
        ("spaced thematic break then setext", "- - -\nHeading\n---\n"),
        ("html type 7 cannot interrupt a paragraph", "alpha\n<span>\nbeta\n"),
        ("bare brackets with no definition", "foo[bar]baz qux\n"),
        ("bare brackets with a definition", "foo[bar]baz qux\n\n[bar]: https://e.com\n"),
        ("crlf inside a code span", "a `one\r\ntwo` b\n"),
        ("code span in a setext heading", "A `one\ntwo` heading\n===\n"),
        ("unclosed frontmatter", "---\ntitle: X\n# Heading\n"),
        ("ordered list paragraph interruption", "alpha\n2. beta\n\nalpha\n1. beta\n\nalpha\n2.\n"),
        ("named and numeric character references", "# A &amp; B &#38; C &#x26; D\n"),
        ("em space reference splits words", "one&emsp;two\n"),
        ("em space reference in heading", "# one&emsp;two\n"),
        ("space invalidates bare link destination", "a[foo](bar baz)b\n"),
        (
            "invalid numeric references become replacement characters",
            "a&#0;b a&#xD800;b a&#x110000;b\n"
        ),
        (
            "html block types 3 4 and 5",
            "<?php hidden words ?>\n\n<!DOCTYPE hidden words>\n\n<![CDATA[ hidden words ]]>\n\nVisible.\n"
        ),
        (
            "definition inside fenced code",
            "```\n[ref]: https://example.com\n```\n\n![alt][ref] and [text][ref]\n"
        ),
        (
            "shortcut and collapsed images",
            "![missing][ref] ![missing] ![defined][] ![defined]\n\n[defined]: /image.png\n"
        ),
    ]

    @Test("WordCount agrees with the JS core", arguments: documents)
    func wordCount(document: (name: String, markdown: String)) async throws {
        let core = try Fixtures.shared()
        let authority = try await core.countWords(document.markdown)
        #expect(
            WordCount.count(document.markdown) == authority,
            "\(document.name): \(document.markdown.debugDescription) — Swift said \(WordCount.count(document.markdown)), the core said \(authority)"
        )
    }

    @Test("Outline agrees with the JS core", arguments: documents)
    func outline(document: (name: String, markdown: String)) async throws {
        let core = try Fixtures.shared()
        let authority = try await core.parseOutline(document.markdown)
        let ours = Outline.parse(document.markdown)
        #expect(
            ours.count == authority.count,
            "\(document.name): got \(ours.count) headings, the core said \(authority.count) — \(ours)")
        for (index, pair) in zip(ours, authority).enumerated() {
            let (got, want) = pair
            #expect(
                got.depth == want.depth && got.offset == want.offset && got.index == want.index
                    && sameCodeUnits(got.text, want.text),
                "\(document.name)[\(index)]: got \(got), the core said \(want)")
        }
    }
}
