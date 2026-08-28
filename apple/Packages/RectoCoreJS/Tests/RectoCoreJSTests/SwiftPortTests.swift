import Foundation
import Testing

@testable import RectoCoreJS

/// `WordCount` and `Outline` are the per-keystroke stand-ins for the JS core.
///
/// They exist because a whole-document `RectoCore` call costs ~10 ms per kB of
/// markdown on a Mac and more on iOS, which is fine at a document boundary and
/// impossible on every keystroke. That only works if they agree with the core,
/// so every one of these runs the shared fixture *and*, where the bundle is
/// built, the core itself.
@Suite("Swift ports")
struct SwiftPortTests {
    let corpus: Corpus

    init() throws {
        corpus = try Fixtures.load(Corpus.self, "markdown-corpus.json")
    }

    // MARK: - Word count

    @Test("WordCount matches word-count.json")
    func wordCountFixture() throws {
        let fixture = try Fixtures.load(WordCountFixture.self, "word-count.json")
        for testCase in fixture.cases {
            #expect(
                WordCount.count(testCase.markdown) == testCase.words,
                "\(testCase.name): \(testCase.markdown.debugDescription)")
        }
    }

    @Test("WordCount matches the corpus")
    func wordCountCorpus() {
        for testCase in corpus.cases + corpus.unicode {
            #expect(
                WordCount.count(testCase.input) == testCase.words,
                "case \(testCase.id) (\(testCase.name))")
        }
    }

    @Test("WordCount agrees with the JS core")
    func wordCountAgreesWithCore() async throws {
        let core = try Fixtures.core()
        for testCase in corpus.cases + corpus.unicode {
            let authority = try await core.countWords(testCase.input)
            #expect(
                WordCount.count(testCase.input) == authority,
                "case \(testCase.id) (\(testCase.name)) diverges from RectoCore.countWords")
        }
    }

    // MARK: - Outline

    @Test("Outline matches outline.json")
    func outlineFixture() throws {
        let fixture = try Fixtures.load(OutlineFixture.self, "outline.json")
        for testCase in fixture.cases {
            expectOutline(
                Outline.parse(testCase.markdown), testCase.outline, testCase.name,
                testCase.markdown)
        }
    }

    @Test("Outline matches the corpus")
    func outlineCorpus() {
        for testCase in corpus.cases + corpus.unicode {
            expectOutline(
                Outline.parse(testCase.input), testCase.outline,
                "case \(testCase.id) (\(testCase.name))", testCase.input)
        }
    }

    @Test("Outline agrees with the JS core")
    func outlineAgreesWithCore() async throws {
        let core = try Fixtures.core()
        for testCase in corpus.cases + corpus.unicode {
            let authority = try await core.parseOutline(testCase.input)
            expectOutline(
                Outline.parse(testCase.input), authority,
                "case \(testCase.id) (\(testCase.name)) diverges from RectoCore.parseOutline",
                testCase.input)
        }
    }

    @Test("outline offsets are UTF-16 code units, not Character counts")
    func outlineOffsetsAreUTF16() {
        // A `Character`-based port passes every ASCII fixture and then puts the
        // caret in the wrong place the first time someone writes an emoji.
        let markdown = "# 👨‍👩‍👧‍👦\n\n## After\n"
        let outline = Outline.parse(markdown)
        #expect(outline.count == 2)
        #expect(outline.last?.offset == (markdown as NSString).range(of: "## After").location)
    }

    private func expectOutline(
        _ actual: [OutlineHeading], _ expected: [OutlineHeading], _ what: String,
        _ markdown: String, sourceLocation: SourceLocation = #_sourceLocation
    ) {
        guard actual.count == expected.count else {
            Issue.record(
                "\(what): got \(actual.count) headings, expected \(expected.count) — \(actual)",
                sourceLocation: sourceLocation)
            return
        }
        for (index, pair) in zip(actual, expected).enumerated() {
            let (got, want) = pair
            let same =
                got.depth == want.depth && got.offset == want.offset && got.index == want.index
                && sameCodeUnits(got.text, want.text)
            #expect(
                same, "\(what)[\(index)]: got \(got), expected \(want)",
                sourceLocation: sourceLocation)
        }
    }
}
