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
//      swift test --filter Perf -c release
//
//  This measures parse + style + apply, up to the point the text storage has
//  the new attributes — not keystroke-to-pixels, which needs a window on
//  screen (the N0b spike measured that end to end and is the reference for
//  the drawing half).
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
        let harness = EditorHarness(markdown: PatchCaretTests.longDocument())
        let anchor = (harness.textView.string as NSString).range(of: "Section 200")
        harness.textView.setSelectedRange(NSRange(location: NSMaxRange(anchor) + 40, length: 0))

        var samples: [Double] = []
        for index in 0..<160 {
            // Without this the footprint climbs into the gigabytes over a
            // synthetic run and reads as a leak (N0b learning).
            autoreleasepool {
                let start = CACurrentMediaTime()
                harness.textView.insertText("x", replacementRange: harness.textView.selectedRange())
                samples.append((CACurrentMediaTime() - start) * 1000)
            }
            _ = index
        }
        report("typing", samples.dropFirst(20))
        #expect(percentile(samples.dropFirst(20), 0.5) < Self.typingBudgetMilliseconds)
    }

    @Test("moving the caret into and out of a heading, under 16 ms")
    func revealBudget() {
        let harness = EditorHarness(markdown: PatchCaretTests.longDocument())
        let heading = (harness.textView.string as NSString).range(of: "## Section 200")
        let away = NSRange(location: NSMaxRange(heading) + 80, length: 0)

        var samples: [Double] = []
        for _ in 0..<120 {
            autoreleasepool {
                var start = CACurrentMediaTime()
                harness.textView.setSelectedRange(NSRange(location: heading.location + 4, length: 0))
                samples.append((CACurrentMediaTime() - start) * 1000)
                start = CACurrentMediaTime()
                harness.textView.setSelectedRange(away)
                samples.append((CACurrentMediaTime() - start) * 1000)
            }
        }
        report("reveal", samples.dropFirst(20))
        #expect(percentile(samples.dropFirst(20), 0.95) < Self.revealBudgetMilliseconds)
    }

    private func percentile(_ samples: ArraySlice<Double>, _ fraction: Double) -> Double {
        let sorted = samples.sorted()
        guard !sorted.isEmpty else { return 0 }
        return sorted[min(sorted.count - 1, Int(Double(sorted.count) * fraction))]
    }

    private func report(_ name: String, _ samples: ArraySlice<Double>) {
        print(String(format: "%@ n=%d p50=%.2f ms p95=%.2f ms max=%.2f ms",
                     name, samples.count,
                     percentile(samples, 0.5), percentile(samples, 0.95),
                     samples.max() ?? 0))
    }
}
