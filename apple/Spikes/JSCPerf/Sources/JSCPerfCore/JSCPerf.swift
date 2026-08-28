import Foundation
import JavaScriptCore

/// Times `RectoCore.normalize` at the document sizes plan 023 §1.5 cares about.
///
/// Deliberately does not depend on `RectoCoreJS`: this measures the raw
/// `JSContext`, so nothing about the wrapper — its queue, its error checking —
/// is in the number. It also has to build for iOS, where `RectoCoreJS`'s
/// package resources would need staging.
public enum JSCPerf {
    public struct Measurement: Sendable {
        public let label: String
        public let kilobytes: Double
        public let milliseconds: Double
        public var millisecondsPerKilobyte: Double { milliseconds / kilobytes }
    }

    public struct Report: Sendable {
        public let jitEnabled: Bool
        public let addLoopMilliseconds: Double
        public let loadMilliseconds: Double
        public let measurements: [Measurement]

        public var text: String {
            var lines = [
                String(
                    format: "JIT probe   10^8 add loop: %.0f ms  →  %@",
                    addLoopMilliseconds,
                    jitEnabled
                        ? "JIT is running" : "INTERPRETER ONLY (LLInt)"),
                String(format: "load        evaluateScript: %.1f ms", loadMilliseconds),
            ]
            for measurement in measurements {
                lines.append(
                    String(
                        format: "normalize   %-10@ %8.1f ms  (%.1f ms/kB)",
                        measurement.label as NSString, measurement.milliseconds,
                        measurement.millisecondsPerKilobyte))
            }
            return lines.joined(separator: "\n")
        }
    }

    /// The three sizes the go/no-go is stated in, plus the budget's own 50 kB.
    public static let sizesInKilobytes = [8, 50, 64, 250]

    public static func run(bundle: String) throws -> Report {
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
        // 77 ms with `com.apple.security.cs.allow-jit`, 492 ms without. Those
        // are the two regimes; the threshold only has to separate them.
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

        var measurements: [Measurement] = []
        for size in sizesInKilobytes {
            let document = prose(kilobytes: size)
            let bytes = Double(document.utf8.count) / 1024
            let start = DispatchTime.now()
            let result = core.invokeMethod("normalize", withArguments: [document])
            let elapsed = milliseconds(since: start)
            guard let result, result.isString else {
                throw Failure("normalize returned a non-string at \(size) kB")
            }
            measurements.append(
                Measurement(label: "\(size) kB", kilobytes: bytes, milliseconds: elapsed))
        }

        return Report(
            jitEnabled: addLoop < 250, addLoopMilliseconds: addLoop,
            loadMilliseconds: load, measurements: measurements)
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
