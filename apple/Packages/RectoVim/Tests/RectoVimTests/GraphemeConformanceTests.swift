import Foundation
import Testing

@testable import RectoVim

/// Unicode's own `GraphemeBreakTest.txt`, run against `GraphemeClamp`.
///
/// The Bun suite runs the same file against `src/grapheme.js`. That is the whole
/// argument: the two sides of the bridge have to agree about where a character
/// ends, and both matching the standard is a much stronger claim than either
/// matching a hand-written list. The pair this replaced passed such a list while
/// splitting Hangul syllables, SpacingMarks and CRLF.
@Suite("UAX #29 conformance")
struct GraphemeConformanceTests {
    struct ConformanceCase {
        let line: Int
        let text: String
        /// UTF-16 offsets, ascending, including 0 and the string's length.
        let boundaries: [Int]
        let description: String
    }

    /// Rows where the platform's ICU disagrees with the vendored UCD.
    ///
    /// Not softening: nothing *outside* the list may diverge, which is the
    /// assertion that catches a regression. The list itself is per-ICU, so an
    /// entry that goes unused on a given platform is reported rather than
    /// failed. The same line numbers are recorded in
    /// `packages/recto-vim-js/test/grapheme.bun.test.ts` — both sides are ICU,
    /// so on one machine they diverge together, which is the property that
    /// actually matters.
    ///
    /// 1105: `2701 ZWJ 2701` (UPPER BLADE SCISSORS). GB11 joins
    /// Extended_Pictographic × ZWJ × Extended_Pictographic; macOS 26's ICU works
    /// from an older Extended_Pictographic set in which U+2701 is not one.
    static let knownICUDivergences: Set<Int> = [1105]

    static let cases: [ConformanceCase] = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        url = url.deletingLastPathComponent()
            .appending(path: "packages/editor-fixtures/unicode/GraphemeBreakTest.txt")
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return [] }

        var parsed: [ConformanceCase] = []
        for (index, raw) in contents.split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated()
        {
            let body = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
                .trimmingCharacters(in: .whitespaces)
            if body.isEmpty { continue }

            var text = ""
            var boundaries: [Int] = []
            for token in body.split(separator: " ") {
                // `÷` is a break, `×` is not, everything else is a hex code point.
                if token == "÷" {
                    boundaries.append(text.utf16.count)
                } else if token == "×" {
                    continue
                } else if let value = UInt32(token, radix: 16),
                    let scalar = Unicode.Scalar(value)
                {
                    text.unicodeScalars.append(scalar)
                }
            }
            let comment = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
            parsed.append(
                ConformanceCase(
                    line: index + 1, text: text, boundaries: boundaries,
                    description: comment.count > 1
                        ? String(comment[1]).trimmingCharacters(in: .whitespaces) : ""))
        }
        return parsed
    }()

    @Test("the conformance file parsed")
    func parsed() {
        // Unicode 16 has about 1,100 rows. A parser that quietly produced
        // nothing would make every assertion below vacuous.
        #expect(Self.cases.count > 600)
        #expect(Self.cases.allSatisfy { $0.boundaries.first == 0 })
    }

    @Test("every row's boundaries match")
    func boundariesMatch() {
        // Reported as a list, never a count and never truncated.
        var failures: [String] = []
        for item in Self.cases where !Self.knownICUDivergences.contains(item.line) {
            let actual = GraphemeClamp.boundaries(in: item.text as NSString)
            if actual != item.boundaries {
                failures.append(
                    "line \(item.line): got \(actual), expected \(item.boundaries) — \(item.description)"
                )
            }
        }
        #expect(failures.isEmpty, "\(failures.count) row(s):\n\(failures.joined(separator: "\n"))")
    }

    @Test("the allowance list stays small, and says which entries went unused")
    func allowanceIsCurrent() {
        // The strict half is above: a row outside the list may not diverge. This
        // half cannot be an assertion, because the list is per-ICU — macOS 26
        // needs line 1105 and a newer ICU does not — and failing on the platform
        // that is *more* correct would be backwards. So an unused entry is
        // reported, and the list is capped so it cannot become a way of passing.
        let unused = Self.cases
            .filter { Self.knownICUDivergences.contains($0.line) }
            .filter { GraphemeClamp.boundaries(in: $0.text as NSString) == $0.boundaries }
            .map(\.line)
        if !unused.isEmpty {
            print("note: this platform's ICU does not need the allowance for line(s) \(unused)")
        }
        #expect(Self.knownICUDivergences.count < 5)
    }

    @Test("every offset resolves to the cluster it is inside")
    func offsetsResolve() {
        // This is what catches a windowed lookup disagreeing with a full walk.
        var failures: [String] = []
        for item in Self.cases where !Self.knownICUDivergences.contains(item.line) {
            let text = item.text as NSString
            for i in 0..<(item.boundaries.count - 1) {
                let start = item.boundaries[i]
                let end = item.boundaries[i + 1]
                for offset in start..<end {
                    let gotStart = GraphemeClamp.clusterStart(in: text, offset: offset)
                    if gotStart != start {
                        failures.append(
                            "line \(item.line): clusterStart(\(offset)) gave \(gotStart), expected \(start)"
                        )
                    }
                    let wanted = offset == start ? start : end
                    let gotEnd = GraphemeClamp.clusterEnd(in: text, offset: offset)
                    if gotEnd != wanted {
                        failures.append(
                            "line \(item.line): clusterEnd(\(offset)) gave \(gotEnd), expected \(wanted)"
                        )
                    }
                }
            }
        }
        #expect(failures.isEmpty, "\(failures.count):\n\(failures.prefix(20).joined(separator: "\n"))")
    }

    @Test("a cluster longer than the scan window still resolves, at every offset")
    func longCluster() {
        // 400 combining acutes is well past the 256-unit expected context. The
        // previous version stopped scanning there and reported whatever position
        // it had reached: `clusterStart(offset: 300)` returned 44, inventing a
        // boundary in the middle of a cluster that starts at 1. Checking one
        // offset was how that survived — this checks all of them.
        let cluster = "e" + String(repeating: "\u{0301}", count: 400)
        let text = "a\(cluster)b" as NSString
        let end = 1 + cluster.utf16.count
        #expect(cluster.count == 1, "the sample is not one Character")

        var wrong: [Int] = []
        for offset in 1..<end {
            if GraphemeClamp.clusterStart(in: text, offset: offset) != 1 { wrong.append(offset) }
            let wantedEnd = offset == 1 ? 1 : end
            if GraphemeClamp.clusterEnd(in: text, offset: offset) != wantedEnd {
                wrong.append(-offset)
            }
        }
        #expect(wrong.isEmpty, "\(wrong.count) offsets resolved wrongly, e.g. \(wrong.prefix(5))")
        #expect(GraphemeClamp.isBoundary(in: text, offset: end))
        #expect(
            GraphemeClamp.range(in: text, NSRange(location: 300, length: 1))
                == NSRange(location: 1, length: cluster.utf16.count))
    }

    @Test("a long run with no ASCII or line ending anywhere before it")
    func longClusterWithNoAnchor() {
        // Nothing in this string proves a boundary except offset 0, so the scan
        // has to walk all the way back rather than stopping at its window.
        let cluster = "\u{1100}" + String(repeating: "\u{0301}", count: 400)
        let text = cluster as NSString
        #expect(GraphemeClamp.clusterStart(in: text, offset: 300) == 0)
        #expect(GraphemeClamp.clusterEnd(in: text, offset: 300) == text.length)
    }

    @Test(
        "the shapes the vim layer cares about",
        arguments: [
            (name: "ZWJ family", cluster: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"),
            (name: "regional-indicator flag", cluster: "\u{1F1FF}\u{1F1E6}"),
            (name: "skin-tone modifier", cluster: "\u{1F44D}\u{1F3FD}"),
            (name: "combining mark", cluster: "e\u{0301}"),
            (name: "single-codepoint emoji", cluster: "\u{1F3A9}"),
            // The four `NSString.rangeOfComposedCharacterSequence` got wrong.
            (name: "Hangul LV", cluster: "\u{1100}\u{1161}"),
            (name: "Hangul LVT", cluster: "\u{1100}\u{1161}\u{11A8}"),
            (name: "SpacingMark", cluster: "\u{0915}\u{093E}"),
            (name: "CRLF", cluster: "\r\n"),
            (name: "Prepend", cluster: "\u{0600}\u{0915}"),
        ])
    func namedShapes(sample: (name: String, cluster: String)) {
        let width = sample.cluster.utf16.count
        let text = "a\(sample.cluster)b" as NSString
        #expect(sample.cluster.count == 1, "\(sample.name) is not one Character")
        for offset in 1..<(1 + width) {
            #expect(GraphemeClamp.clusterStart(in: text, offset: offset) == 1, "\(sample.name)")
            #expect(
                GraphemeClamp.clusterEnd(in: text, offset: offset)
                    == (offset == 1 ? 1 : 1 + width), "\(sample.name)")
        }
        #expect(
            GraphemeClamp.range(in: text, NSRange(location: 1, length: 1))
                == NSRange(location: 1, length: width), "\(sample.name)")
    }
}
