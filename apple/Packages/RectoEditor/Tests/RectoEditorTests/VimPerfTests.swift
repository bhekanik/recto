//
//  VimPerfTests.swift
//  RectoEditorTests
//
//  Per-key cost of the vim layer through the engine's real text view, on the
//  10k-word document, against the raw typing budget (8 ms p50). Opt-in like
//  `PerfTests`: RECTO_RUN_PERF=1 swift test --filter VimPerf -c release
//

import AppKit
import QuartzCore
import RectoVimFixtures
import Testing
@testable import RectoEditor

@MainActor
@Suite("VimPerf", .serialized,
       .disabled(if: ProcessInfo.processInfo.environment["RECTO_RUN_PERF"] == nil,
                 "set RECTO_RUN_PERF=1, and build -c release, to measure"))
struct VimPerfTests {
    private static let budgetMilliseconds = 8.0

    private func mount() throws -> (WindowHarness, NSTextView, RectoVimController) {
        let storage = RectoTextStorage(documentId: "vim-perf", markdown: PatchCaretTests.longDocument())
        let vim = RectoVimController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .vim, theme: .twilight),
                onAttach: { vim.attach(to: $0) }
            ),
            size: CGSize(width: 800, height: 600)
        )
        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        // Start in the middle so `j`/`k` and `x` have text on both sides.
        textView.setSelectedRange(NSRange(location: (textView.string as NSString).length / 2, length: 0))
        return (harness, textView, vim)
    }

    private func samples(_ keys: String, rounds: Int, textView: NSTextView) throws -> [Double] {
        var out: [Double] = []
        for _ in 0..<rounds {
            for key in VimKeys.parse(keys) {
                let event = try #require(key.event)
                autoreleasepool {
                    let start = CACurrentMediaTime()
                    textView.keyDown(with: event)
                    out.append((CACurrentMediaTime() - start) * 1000)
                }
            }
        }
        return Array(out.dropFirst(20))
    }

    @Test("hjkl through the engine view, p50 under 8 ms")
    func motions() throws {
        let (harness, textView, _) = try mount()
        defer { harness.tearDown() }
        let motions = try samples("hjkl", rounds: 100, textView: textView)
        report("vim hjkl", motions)
        #expect(percentile(motions, 0.5) < Self.budgetMilliseconds)
    }

    @Test("x through the engine view, p50 under 8 ms")
    func deleteCharacter() throws {
        let (harness, textView, vim) = try mount()
        defer { harness.tearDown() }
        let deletes = try samples("x", rounds: 300, textView: textView)
        report("vim x", deletes)
        #expect(percentile(deletes, 0.5) < Self.budgetMilliseconds)
        #expect((textView.string as NSString).isEqual(to: vim.engineText ?? ""))
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
