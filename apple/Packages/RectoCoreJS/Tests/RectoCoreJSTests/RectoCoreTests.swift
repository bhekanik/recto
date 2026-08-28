import Foundation
import Testing

@testable import RectoCoreJS

/// The JS core in a real `JSContext`, over the same fixtures the web runs.
///
/// This is the losslessness gate: if the bundle and `lib/` ever disagree, a
/// document written on the Mac and opened on the web would round-trip
/// differently, and nothing else in the app would notice.
@Suite("RectoCore in JavaScriptCore")
struct RectoCoreTests {
    let core: RectoCore
    let corpus: Corpus

    init() throws {
        core = try Fixtures.shared()
        corpus = try Fixtures.load(Corpus.self, "markdown-corpus.json")
    }

    @Test("the harness compares by code unit, not by canonical equivalence")
    func harnessProvesItsOwnComparison() {
        // The first two unicode cases are the NFC/NFD pair. They must be `==`
        // and must differ by code unit — otherwise every string assertion in
        // this file is weaker than it looks.
        let nfc = corpus.unicode[0].normalized
        let nfd = corpus.unicode[1].normalized
        #expect(nfc == nfd, "the NFC/NFD pair is no longer canonically equal")
        #expect(!sameCodeUnits(nfc, nfd), "the NFC/NFD pair has the same code units")
    }

    @Test("normalize matches lib/ on the corpus")
    func normalizeMatchesCorpus() async throws {
        for testCase in corpus.cases + corpus.unicode {
            let normalized = try await core.normalize(testCase.input)
            expectSameCodeUnits(
                normalized, testCase.normalized, "case \(testCase.id) (\(testCase.name))")
            // Corpus gate 25: normalizing canonical output changes nothing.
            expectSameCodeUnits(
                try await core.normalize(normalized), testCase.normalized,
                "case \(testCase.id) idempotence")
        }
    }

    @Test("countWords and parseOutline match lib/ on the corpus")
    func derivedValuesMatchCorpus() async throws {
        for testCase in corpus.cases + corpus.unicode {
            let context = "case \(testCase.id) (\(testCase.name))"
            #expect(try await core.countWords(testCase.input) == testCase.words, "\(context) words")
            #expect(
                try await core.parseOutline(testCase.input) == testCase.outline,
                "\(context) outline")
        }
    }

    @Test("streak walks calendar days")
    func streakMatchesFixture() async throws {
        let fixture = try Fixtures.load(StreakFixture.self, "streak.json")
        for testCase in fixture.cases {
            #expect(
                try await core.streak(testCase.days, today: testCase.today) == testCase.streak,
                "\(testCase.name)")
        }
    }

    @Test("lint settles synchronously and reports issues")
    func lintReturnsIssues() async throws {
        // JSC drains the microtask queue before returning to native code, so the
        // promise `lint` returns has already settled when `invokeMethod` does.
        // A probe with no issues would make this assertion vacuous.
        let issues = try await core.lint("The report was written by the committee.\n")
        #expect(!issues.isEmpty)
        #expect(issues.allSatisfy { $0.from < $0.to })
    }

    @Test("lint categories select and deselect")
    func lintCategories() async throws {
        let markdown = "The report was written by the committee.\n"
        #expect(try await core.lint(markdown, categories: []).isEmpty)
        let passive = try await core.lint(markdown, categories: [.passive])
        #expect(passive.allSatisfy { $0.category == "passive" })
    }

    @Test("html round trips through the preview and smart-paste pipelines")
    func htmlRoundTrip() async throws {
        let html = try await core.htmlFromMarkdown("# Title\n\nSome **bold** text.\n")
        #expect(html.contains("<h1"))
        let markdown = try await core.markdownFromHtml(html)
        expectSameCodeUnits(
            try await core.normalize(markdown), "# Title\n\nSome **bold** text.\n",
            "smart paste of our own preview HTML")
    }

    @Test("bad input throws rather than returning a plausible value")
    func badInputThrows() async throws {
        // A malformed date key matches nothing in the backwards walk, so without
        // the bundle's validation this would quietly return a streak of 0 —
        // indistinguishable from "you have not written". Reading it back is just
        // as lossy: `undefined.toInt32()` is 0.
        await #expect(throws: RectoCoreError.self) {
            _ = try await core.streak(
                [WritingDay(date: "not-a-date", words: 1)], today: "2026-01-01")
        }
        await #expect(throws: RectoCoreError.self) {
            _ = try await core.streak([WritingDay(date: "2026-01-01", words: 1)], today: "today")
        }
        // The context must be usable afterwards: a thrown exception left standing
        // would be reported against the next call instead.
        #expect(try await core.countWords("two words") == 2)
    }

    @Test("a missing bundle names the command that produces it")
    func missingBundleError() {
        let missing = Fixtures.repositoryRoot.appending(path: "no/such/recto-core.js")
        #expect(throws: RectoCoreError.self) {
            _ = try RectoCore(bundleURL: missing)
        }
    }

    @Test("two cores run concurrently on their own queues")
    func concurrentCores() async throws {
        // One context per queue with its own JSVirtualMachine is the documented
        // shape; this proves two instances do not trip over each other.
        let second = try Fixtures.core()
        async let first = core.normalize("# One\n")
        async let other = second.normalize("# Two\n")
        let (a, b) = try await (first, other)
        expectSameCodeUnits(a, "# One\n", "core 1")
        expectSameCodeUnits(b, "# Two\n", "core 2")
    }

    @Test("the bundle resolves from the package's own resources")
    func bundledResource() async throws {
        // Not the same lookup as `Fixtures.core()`: this is the one the app
        // uses, and it broke silently once already when the resource directory
        // had to be renamed for iOS codesigning.
        let url = try RectoCore.bundledScriptURL()
        #expect(FileManager.default.fileExists(atPath: url.path))
        let bundled = try RectoCore()
        expectSameCodeUnits(
            try await bundled.normalize("# Hi\n"), "# Hi\n", "the bundled core")
    }

    @Test("version is the built bundle's stamp")
    func versionIsStamped() {
        #expect(core.version.contains("+"))
        #expect(core.loadDuration > 0)
    }
}
