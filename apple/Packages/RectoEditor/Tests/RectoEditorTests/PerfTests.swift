//
//  PerfTests.swift
//  RectoEditorTests
//
//  The two budgets from plan 023: typing p50 under 8 ms and marker reveal
//  under 16 ms, on a 10k-word document.
//
//  NOT part of the default run. Wall-clock thresholds are a property of the
//  machine, and a shared CI runner would make this flaky enough to teach people
//  to ignore red. Run it deliberately, in Release, and record the numbers:
//
//      RECTO_RUN_PERF=1 swift test --filter Perf -c release
//
//  This measures parse + style + apply, up to the point the text storage has
//  the new attributes — not keystroke-to-pixels, which needs a window on
//  screen. The N0b spike measured that end to end and is the reference for the
//  drawing half.
//

import AppKit
import Foundation
import QuartzCore
import Testing
@testable import RectoEditor

@MainActor
// Serialized: these measure wall clock, and three of them running concurrently
// contend for the same cores. Measured — the 10k-word case read 5 ms alone and
// 13 ms alongside the other two, which would have been a false failure.
@Suite("Perf", .serialized,
       .disabled(if: ProcessInfo.processInfo.environment["RECTO_RUN_PERF"] == nil,
                 "set RECTO_RUN_PERF=1, and build -c release, to measure"))
struct PerfTests {

    private static let typingBudgetMilliseconds = 8.0
    private static let revealBudgetMilliseconds = 16.0
    private static let explicitCommandBudgetMilliseconds = 60.0

    @Test("typing in the middle of a 10k-word document, p50 under 8 ms")
    func typingBudget() {
        let samples = typingSamples(in: PatchCaretTests.longDocument())
        report("typing", samples)
        #expect(percentile(samples, 0.5) < Self.typingBudgetMilliseconds)
    }

    @Test("moving the caret into and out of a heading, under 16 ms")
    func revealBudget() {
        let harness = EditorHarness(markdown: PatchCaretTests.longDocument())
        let heading = (harness.textView.string as NSString).range(of: "## Section 200")
        let away = NSRange(location: NSMaxRange(heading) + 80, length: 0)

        var samples: [Double] = []
        for _ in 0..<120 {
            // Without this the footprint climbs into the gigabytes over a
            // synthetic run and reads as a leak (N0b learning).
            autoreleasepool {
                var start = CACurrentMediaTime()
                harness.textView.setSelectedRange(NSRange(location: heading.location + 4, length: 0))
                samples.append((CACurrentMediaTime() - start) * 1000)
                start = CACurrentMediaTime()
                harness.textView.setSelectedRange(away)
                samples.append((CACurrentMediaTime() - start) * 1000)
            }
        }
        let settled = Array(samples.dropFirst(20))
        report("reveal", settled)
        #expect(percentile(settled, 0.95) < Self.revealBudgetMilliseconds)
    }

    /// A paragraph that runs straight into a fenced code block with no blank
    /// line is valid CommonMark, and is what pressing Return once produces.
    ///
    /// It used to cost three times as much per keystroke — anywhere in the
    /// document, not only near the fence — because `incrementalParse` bailed
    /// whenever the reparsed window ended in a fenced block, forcing a full
    /// reparse of every block and token. Measured on an M3 Max in Release:
    /// 4.4 ms p50 with the blank line, 14.4 ms without, at the same document
    /// length and fragment count. The parser now proves the fence is contained
    /// instead of assuming the worst, and both shapes land at ~5.5 ms.
    ///
    /// Both are asserted, because "we print the number" is how a 14 ms result
    /// passed an 8 ms budget for a whole review round.
    @Test("both fence shapes meet the typing budget")
    func fenceAdjacencyMeetsTheBudget() {
        func document(blankLineBeforeFence: Bool) -> String {
            var out = ""
            for index in 0..<400 {
                out += "## Section \(index)\n\n"
                out += "The **sediment** settles into *layers* that record the weather"
                out += " of a year, and the `core` taken from the lake bed reads like"
                out += " a [ledger](https://example.com) of every summer since the ice left."
                out += blankLineBeforeFence ? "\n\n" : "\n"
                if index % 20 == 0 {
                    out += "```swift\nlet depth = \(index) // cm\n```\n\n"
                }
            }
            return out
        }
        for (label, blankLine) in [("blank line before the fence", true),
                                   ("fence abuts the paragraph", false)] {
            let samples = typingSamples(in: document(blankLineBeforeFence: blankLine))
            report("typing, \(label)", samples)
            #expect(percentile(samples, 0.5) < Self.typingBudgetMilliseconds,
                    "\(label): over the typing budget")
        }
    }

    /// A chain of blocks each of which is classified by what FOLLOWS it.
    ///
    /// The incremental parser extends its reparse window until the trailing
    /// block cannot be reinterpreted by the suffix. A list item and a
    /// blockquote line both absorb following lines, so an alternating chain of
    /// them never reaches a stable trailing block: the window walks to the end
    /// of the document, reparsing from the window START on every extension,
    /// which is quadratic.
    ///
    /// This is a document a reader can type. Same 8 ms budget.
    @Test("an alternating list/blockquote chain meets the typing budget")
    func contextSensitiveChainMeetsTheBudget() {
        // ~20 KB, the plan's mid-size document.
        var document = "# Notes\n\n"
        for index in 0..<840 {
            document += "- item \(index)\n"
            document += "> quoted \(index)\n"
        }
        #expect((document as NSString).length > 18_000)

        let samples = typingSamples(in: document, anchor: "item 200")
        report("typing, alternating list/blockquote chain", samples)
        #expect(percentile(samples, 0.5) < Self.typingBudgetMilliseconds,
                "the context-sensitive reparse window walked the whole document")
    }

    @Test("near-limit explicit formatting stays interactive")
    func explicitFormattingBudget() {
        let prefix = String(repeating: "plain paragraph text\n", count: 47_500)
        let markdown = "**old**\n\n" + prefix + "**target**"
        let selection = (markdown as NSString).range(of: "target", options: .backwards)

        func activeCommand() {
            #expect(RectoCommandTransformer.activeInlineCommands(
                markdown: markdown,
                selection: selection
            ) == [.bold])
        }
        func editCommand() {
            #expect(RectoCommandTransformer.edit(
                command: .bold,
                markdown: markdown,
                selection: selection
            ) != nil)
        }

        let firstActive = milliseconds(ContinuousClock().measure(activeCommand))
        let firstEdit = milliseconds(ContinuousClock().measure(editCommand))
        let activeSamples = (0..<9).map { _ in
            milliseconds(ContinuousClock().measure(activeCommand))
        }
        let editSamples = (0..<9).map { _ in
            milliseconds(ContinuousClock().measure(editCommand))
        }
        report("near-limit first active command", [firstActive])
        report("near-limit first edit command", [firstEdit])
        report("near-limit active command", activeSamples)
        report("near-limit edit command", editSamples)
        #expect(firstActive < Self.explicitCommandBudgetMilliseconds)
        #expect(firstEdit < Self.explicitCommandBudgetMilliseconds)
        #expect(percentile(activeSamples, 0.5) < Self.explicitCommandBudgetMilliseconds)
        #expect(percentile(editSamples, 0.5) < Self.explicitCommandBudgetMilliseconds)
    }

    // MARK: - Helpers

    private func typingSamples(in document: String,
                               anchor anchorText: String = "Section 200") -> [Double] {
        let harness = EditorHarness(markdown: document)
        let anchor = (harness.textView.string as NSString).range(of: anchorText)
        harness.textView.setSelectedRange(NSRange(location: NSMaxRange(anchor), length: 0))
        var samples: [Double] = []
        for _ in 0..<140 {
            autoreleasepool {
                let start = CACurrentMediaTime()
                harness.textView.insertText("x", replacementRange: harness.textView.selectedRange())
                samples.append((CACurrentMediaTime() - start) * 1000)
            }
        }
        // The first keystrokes pay for caches the reader pays for once.
        return Array(samples.dropFirst(20))
    }

    private func percentile(_ samples: [Double], _ fraction: Double) -> Double {
        let sorted = samples.sorted()
        guard !sorted.isEmpty else { return 0 }
        return sorted[min(sorted.count - 1, Int(Double(sorted.count) * fraction))]
    }

    private func milliseconds(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }

    private func report(_ name: String, _ samples: [Double]) {
        print(String(format: "%@ n=%d p50=%.2f ms p95=%.2f ms max=%.2f ms",
                     name, samples.count,
                     percentile(samples, 0.5), percentile(samples, 0.95),
                     samples.max() ?? 0))
    }
}
