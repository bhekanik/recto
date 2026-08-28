import Foundation
import Testing

@testable import RectoCoreJS

/// Per-size latency for the JS core and its Swift ports.
///
/// Opt-in (`RECTO_CORE_PERF=1`) and **not a gate**: these numbers depend on the
/// signing of the process that runs them, which is the whole point. A
/// hardened-runtime process without `com.apple.security.cs.allow-jit` gets no
/// JIT from JavaScriptCore and runs ~13x slower — see
/// `apple/Spikes/JSCPerf/README.md`. On a CI runner they would be noise; here
/// they are a record you can re-run after a bundle change.
///
/// What they are for: deciding what may be called on a keystroke. `WordCount`
/// and `Outline` are the answer for the typing path, and the ratio these print
/// is the reason.
@Suite(
    "latency",
    .enabled(if: ProcessInfo.processInfo.environment["RECTO_CORE_PERF"] == "1"))
struct LatencyTests {
    static let bundleURL: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
            .appending(path: "packages/recto-core-js/dist/recto-core.js")
    }()

    static let sizesInKilobytes = [8, 50, 64, 250]

    @Test("whole-document calls, JS core against the Swift ports")
    func perSize() async throws {
        let core = try RectoCore(bundleURL: Self.bundleURL)
        print(String(format: "\nload  %.1f ms  (%@)", core.loadDuration * 1000, core.version))
        print("size      normalize   countWords   parseOutline   Swift words   Swift outline")
        for size in Self.sizesInKilobytes {
            let document = Self.prose(kilobytes: size)
            let normalize = try await milliseconds { _ = try await core.normalize(document) }
            let words = try await milliseconds { _ = try await core.countWords(document) }
            let outline = try await milliseconds { _ = try await core.parseOutline(document) }
            let swiftWords = milliseconds { _ = WordCount.count(document) }
            let swiftOutline = milliseconds { _ = Outline.parse(document) }
            print(
                String(
                    format: "%-8@ %9.1f %12.1f %14.1f %13.2f %15.2f",
                    "\(size) kB" as NSString, normalize, words, outline, swiftWords, swiftOutline))
        }
    }

    @Test("the Swift ports are fast enough for a keystroke")
    func swiftPortsAreCheap() {
        // 16 kB is a long article, ~2,600 words. The typing budget is 8 ms for
        // the whole frame (plan 023 §1.3) and word count and outline are two of
        // the things sharing it, so a quarter of it each is the useful claim.
        //
        // They stay linear: a 64 kB document costs ~7 ms and a 250 kB one ~25 ms
        // in a release build, which is why the typing path debounces rather than
        // recounting the whole document on every key. `perSize` prints those.
        let document = Self.prose(kilobytes: 16)
        let words = milliseconds { _ = WordCount.count(document) }
        let outline = milliseconds { _ = Outline.parse(document) }
        print(String(format: "\n16 kB: WordCount %.2f ms, Outline %.2f ms", words, outline))
        // Only in a release build. A debug build is ~4.5x slower here (7.4 ms
        // against 1.7 ms), and asserting a number that depends on the build
        // configuration is a flaky test, not a budget.
        #if !DEBUG
        #expect(words < 2)
        #expect(outline < 2)
        #endif
    }

    static func prose(kilobytes: Int) -> String {
        let paragraph = """
            ## A heading to give the outline something to find

            The quick brown fox jumps over the lazy dog, and then does it again \
            because that is what foxes in benchmark documents are for. Some of \
            this is **bold**, some is _italic_, and one clause has a \
            [link](https://example.com) in it.

            """
        let target = kilobytes * 1024
        var document = ""
        document.reserveCapacity(target + paragraph.utf8.count)
        while document.utf8.count < target { document += paragraph }
        return document
    }

    /// Best of three: the interesting quantity is the cost of the work, and the
    /// slow runs are whatever else the machine was doing.
    func milliseconds(_ body: () throws -> Void) rethrows -> Double {
        var best = Double.greatestFiniteMagnitude
        for _ in 0..<3 {
            let start = DispatchTime.now()
            try body()
            best = min(best, RectoCore.seconds(since: start) * 1000)
        }
        return best
    }

    func milliseconds(_ body: () async throws -> Void) async rethrows -> Double {
        var best = Double.greatestFiniteMagnitude
        for _ in 0..<3 {
            let start = DispatchTime.now()
            try await body()
            best = min(best, RectoCore.seconds(since: start) * 1000)
        }
        return best
    }
}
