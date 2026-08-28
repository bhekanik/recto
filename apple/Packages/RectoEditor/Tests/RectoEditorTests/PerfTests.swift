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
@Suite("Perf", .disabled(if: ProcessInfo.processInfo.environment["RECTO_RUN_PERF"] == nil,
                         "set RECTO_RUN_PERF=1, and build -c release, to measure"))
struct PerfTests {

    private static let typingBudgetMilliseconds = 8.0
    private static let revealBudgetMilliseconds = 16.0

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
    /// line between them costs roughly three times as much per keystroke —
    /// anywhere in the document, not only near the fence. Measured on an M3 Max
    /// in Release: 6.1 ms p50 with the blank line, 16.2 ms without, on documents
    /// of the same length (85k characters) and the same fragment count.
    ///
    /// Canonical Markdown always writes the blank line, so a document that has
    /// been through `serialize(parse(md))` never has this shape — but a document
    /// being typed has not, and this is what a reader creates by pressing Return
    /// once instead of twice. Not gated: it records the number so the stage-2
    /// investigation starts from a measurement rather than a guess.
    @Test("cost of a paragraph abutting a fence, with and without a blank line")
    func fenceAdjacencyCost() {
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
        report("typing, blank line before the fence",
               typingSamples(in: document(blankLineBeforeFence: true)))
        report("typing, fence abuts the paragraph",
               typingSamples(in: document(blankLineBeforeFence: false)))
    }

    // MARK: - Helpers

    private func typingSamples(in document: String) -> [Double] {
        let harness = EditorHarness(markdown: document)
        let anchor = (harness.textView.string as NSString).range(of: "Section 200")
        harness.textView.setSelectedRange(NSRange(location: NSMaxRange(anchor) + 40, length: 0))
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

    private func report(_ name: String, _ samples: [Double]) {
        print(String(format: "%@ n=%d p50=%.2f ms p95=%.2f ms max=%.2f ms",
                     name, samples.count,
                     percentile(samples, 0.5), percentile(samples, 0.95),
                     samples.max() ?? 0))
    }
}
