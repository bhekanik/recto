#if canImport(AppKit)
import AppKit
import Foundation
import Testing

import RectoVimFixtures
@testable import RectoVim

/// Per-key latency against plan 023 §1.4's < 2 ms budget.
///
/// Opt-in (`RECTO_VIM_PERF=1`): it builds a 950 kB document and runs thousands
/// of keys, which is tens of seconds and pure noise on a shared CI runner.
///
/// **Measured in CPU time, not wall clock.** The N0c spike found wall-clock p99
/// swinging 0.5 ms → 42 ms across runs of identical code, purely because other
/// work was on the machine. `clock_gettime(CLOCK_THREAD_CPUTIME_ID)` measures
/// what this thread actually did, which is the thing the budget is about; on an
/// idle machine the two agree to three decimal places.
@Suite(
    "per-key latency",
    .enabled(if: ProcessInfo.processInfo.environment["RECTO_VIM_PERF"] == "1"))
@MainActor
struct PerKeyLatencyTests {
    /// A realistic mix: motions, an operator, insert-mode typing, escape, `x`,
    /// line starts and ends. Not `l` ten thousand times, which would measure the
    /// cheapest possible key.
    static let script = "wwbde0$xiabc\u{1B}jjkkdwu"

    @Test(
        "a keystroke stays inside the budget",
        arguments: [
            (label: "2.6k words", repeats: 180),
            (label: "10k words", repeats: 700),
            (label: "150k words", repeats: 10500),
        ])
    func latency(document: (label: String, repeats: Int)) throws {
        let text = Self.document(paragraphs: document.repeats)
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        textView.isRichText = false
        textView.string = text
        let host = VimHost()
        let engine = try VimEngine(bundleURL: Fixtures.bundleURL, host: host)
        let adapter = VimTextViewAdapter(textView: textView, engine: engine, host: host)
        try adapter.start()

        let keys = VimKeys.parse(Self.script)
        // JSC runs interpreted until the JIT settles; the first few hundred keys
        // are not what a typing session looks like.
        for _ in 0..<40 {
            for key in keys { _ = adapter.handle(key: key.key, modifiers: key.modifiers) }
        }

        var samples: [Double] = []
        samples.reserveCapacity(1600)
        for _ in 0..<80 {
            for key in keys {
                let start = Self.cpuSeconds()
                _ = adapter.handle(key: key.key, modifiers: key.modifiers)
                samples.append((Self.cpuSeconds() - start) * 1000)
            }
        }
        samples.sort()
        let p50 = samples[samples.count / 2]
        let p95 = samples[Int(Double(samples.count) * 0.95)]
        print(
            String(
                format: "%-12@ n=%d  cpu p50 %.4f ms  p95 %.4f ms  (%d UTF-16 units)",
                document.label as NSString, samples.count, p50, p95, (text as NSString).length))
        #expect(p95 < 2.0, "\(document.label): p95 \(p95) ms exceeds the 2 ms budget")
    }

    @Test("loading the bundle is a one-off few milliseconds")
    func loadTime() throws {
        let host = VimHost()
        let engine = try VimEngine(bundleURL: Fixtures.bundleURL, host: host)
        print(String(format: "JSContext load: %.2f ms", engine.loadDuration * 1000))
        #expect(engine.loadDuration < 0.05)
    }

    static func document(paragraphs: Int) -> String {
        let paragraph = """
            The quick brown fox jumps over the lazy dog, and then it does so \
            again because that is what foxes in test documents are for.

            """
        return String(repeating: paragraph, count: paragraphs)
    }

    static func cpuSeconds() -> Double {
        var time = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time)
        return Double(time.tv_sec) + Double(time.tv_nsec) / 1_000_000_000
    }
}

/// The perf target is separate from `RectoVimTests`, so it needs its own view of
/// the fixtures. Kept to the two things it uses rather than duplicating the file.
enum Fixtures {
    static let repositoryRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
    }()

    static var bundleURL: URL {
        repositoryRoot.appending(path: "packages/recto-vim-js/dist/recto-vim.js")
    }
}

enum VimKeys {
    static func parse(_ spec: String) -> [(key: String, modifiers: VimModifiers)] {
        spec.map { character in
            let key = String(character)
            let shifted = character.isUppercase && character.isLetter
            return (key == "\u{1B}" ? "Escape" : key, shifted ? .shift : [])
        }
    }
}
#endif
