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
    /// Not softening: each is asserted to *still* diverge, so an OS update that
    /// fixes one fails this suite and the entry gets removed, and nothing
    /// outside the list may diverge. The same line numbers are recorded in
    /// `packages/recto-vim-js/test/grapheme.bun.test.ts` — both sides are ICU,
    /// so they diverge together, which is the property that actually matters.
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

    @Test("every recorded ICU divergence is still a divergence")
    func divergencesAreCurrent() {
        // An allowance nobody re-checks is an allowance that outlives its reason.
        let stale = Self.cases
            .filter { Self.knownICUDivergences.contains($0.line) }
            .filter { GraphemeClamp.boundaries(in: $0.text as NSString) == $0.boundaries }
            .map(\.line)
        #expect(stale.isEmpty, "no longer diverging: \(stale)")
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

    @Test("a cluster longer than the context window still resolves")
    func longCluster() {
        // The windowed lookup falls back to a full walk rather than guessing.
        // 400 combining acutes is well past the 256-unit window.
        let cluster = "e" + String(repeating: "\u{0301}", count: 400)
        let text = "a\(cluster)b" as NSString
        #expect(GraphemeClamp.clusterStart(in: text, offset: 200) == 1)
        #expect(GraphemeClamp.clusterEnd(in: text, offset: 200) == 1 + cluster.utf16.count)
        #expect(GraphemeClamp.isBoundary(in: text, offset: 1 + cluster.utf16.count))
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
