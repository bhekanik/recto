import Foundation
import JavaScriptCore

/// Times `RectoCore.normalize` at the document sizes plan 023 §1.5 cares about.
///
/// Deliberately does not depend on `RectoCoreJS`: this measures the raw
/// `JSContext`, so nothing about the wrapper — its queue, its error checking —
/// is in the number. It also has to build for iOS, where `RectoCoreJS`'s package
/// resources would need staging.
///
/// ## How it measures, and why
///
/// One sample per size in a fixed order is not a measurement: JavaScriptCore
/// tiers up as it runs, so the first size pays for warming the engine and every
/// later size gets the benefit. The first version of this harness reported 64 kB
/// as *faster* than 50 kB, which is the signature of that contamination.
///
/// So: each size is measured `repetitions` times, the order is reshuffled every
/// round, and the report carries the median and p95 rather than a single number.
/// `measure.sh` then runs the whole thing in several fresh processes, because a
/// warmed engine is a different machine from a cold one and only the caller can
/// produce a cold one.
public enum JSCPerf {
    public struct Measurement: Sendable {
        public let label: String
        public let kilobytes: Double
        public let samples: [Double]

        public var median: Double { Self.percentile(samples, 0.5) }
        public var p95: Double { Self.percentile(samples, 0.95) }
        public var best: Double { samples.min() ?? 0 }
        public var medianPerKilobyte: Double { median / kilobytes }

        static func percentile(_ values: [Double], _ fraction: Double) -> Double {
            guard !values.isEmpty else { return 0 }
            let sorted = values.sorted()
            let index = Int((Double(sorted.count - 1) * fraction).rounded())
            return sorted[index]
        }
    }

    public struct Report: Sendable {
        public let jitEnabled: Bool
        public let addLoopMilliseconds: Double
        public let loadMilliseconds: Double
        public let repetitions: Int
        public let measurements: [Measurement]

        public var text: String {
            var lines = [
                String(
                    format: "JIT probe   10^8 add loop: %.0f ms  →  %@",
                    addLoopMilliseconds,
                    jitEnabled ? "JIT is running" : "INTERPRETER ONLY (no JIT)"),
                String(format: "load        evaluateScript: %.1f ms", loadMilliseconds),
                "normalize   (n=\(repetitions) per size, order reshuffled each round)",
            ]
            for measurement in measurements {
                lines.append(
                    String(
                        format: "            %-8@ median %8.1f ms   p95 %8.1f ms   best %8.1f ms   (%.1f ms/kB)",
                        measurement.label as NSString, measurement.median, measurement.p95,
                        measurement.best, measurement.medianPerKilobyte))
            }
            return lines.joined(separator: "\n")
        }
    }

    /// The three sizes the go/no-go is stated in, plus the budget's own 50 kB.
    public static let sizesInKilobytes = [8, 50, 64, 250]

    public static func run(bundle: String, repetitions: Int = 5) throws -> Report {
        guard let context = JSContext() else {
            throw Failure("JSContext() returned nil")
        }
        // The bundle installs a no-op console itself, but only if none exists;
        // on a device we want anything it logs in the process output.
        let emit: @convention(block) (String) -> Void = { print("[js] \($0)") }
        if let console = JSValue(newObjectIn: context) {
            for name in ["log", "info", "warn", "error", "debug"] {
                console.setValue(emit, forProperty: name)
            }
            context.setObject(console, forKeyedSubscript: "console" as NSString)
        }

        // Whether the JIT is on is the whole question, and there is no API that
        // reports it — so measure. Calibrated on this loop, M-series, macOS 26:
        // 77-79 ms with `com.apple.security.cs.allow-jit`, 490-492 ms without.
        // Those are the two regimes; the threshold only has to separate them.
        let loopStart = DispatchTime.now()
        context.evaluateScript(
            "(function(){var s=0;for(var i=0;i<100000000;i++)s+=i;return s;})()")
        let addLoop = milliseconds(since: loopStart)

        var thrown: String?
        context.exceptionHandler = { _, value in thrown = value?.toString() }

        let loadStart = DispatchTime.now()
        context.evaluateScript(bundle)
        let load = milliseconds(since: loadStart)
        if let thrown { throw Failure("evaluating the bundle threw: \(thrown)") }

        guard let core = context.objectForKeyedSubscript("RectoCore"), !core.isUndefined else {
            throw Failure("globalThis.RectoCore is undefined")
        }

        let documents = sizesInKilobytes.map {
            (size: $0, text: prose(kilobytes: $0))
        }
        var samples: [Int: [Double]] = [:]
        // A deterministic shuffle: a different order every round, the same
        // sequence of orders every run, so two runs are comparable.
        var random = SplitMix64(seed: 0x5EED_1234_ABCD_0001)
        for _ in 0..<max(1, repetitions) {
            for document in documents.shuffled(using: &random) {
                let start = DispatchTime.now()
                let result = core.invokeMethod("normalize", withArguments: [document.text])
                let elapsed = milliseconds(since: start)
                guard let result, result.isString else {
                    throw Failure("normalize returned a non-string at \(document.size) kB")
                }
                samples[document.size, default: []].append(elapsed)
            }
        }

        let measurements = documents.map { document in
            Measurement(
                label: "\(document.size) kB",
                kilobytes: Double(document.text.utf8.count) / 1024,
                samples: samples[document.size] ?? [])
        }

        return Report(
            jitEnabled: addLoop < 250, addLoopMilliseconds: addLoop,
            loadMilliseconds: load, repetitions: max(1, repetitions),
            measurements: measurements)
    }

    /// Prose, not markdown syntax: `normalize` cost is dominated by inline
    /// parsing, and a document of headings would flatter it.
    public static func prose(kilobytes: Int) -> String {
        let paragraph = """
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

    static func milliseconds(since start: DispatchTime) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
    }

    public struct Failure: Error, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }
}

/// A seeded generator, so "shuffled" does not mean "different every run".
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
