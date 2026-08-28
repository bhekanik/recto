import Foundation
import Testing

@testable import JSCPerfCore

/// The N3 go/no-go, in a form that runs on a phone.
///
/// `xcodebuild test -destination 'id=<UDID>'` — the bundle is a **resource**
/// rather than a path into the checkout, because on a device there is no
/// checkout. That was the reason this suite could never produce the number it
/// exists to produce.
///
/// The simulator is a Mac process and therefore **has the JIT**, so its numbers
/// are an upper bound on a device rather than the answer. Every run prints
/// whether the JIT was on, so the output cannot be mistaken for a device result,
/// and the budget assertion only applies where it is off.
@Suite("normalize latency")
struct NormalizeLatencyTests {
    /// The N3 budget: 50 kB `normalize` under one second on an iPhone.
    static let budgetMilliseconds = 1000.0

    static func bundleSource() throws -> String {
        guard
            let url = Bundle.module.url(
                forResource: "recto-core", withExtension: "js", subdirectory: "JS")
        else {
            throw MissingBundle()
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    struct MissingBundle: Error, CustomStringConvertible {
        var description: String {
            "recto-core.js is not in the test bundle — run `apple/scripts/copy-js-bundles.sh`"
        }
    }

    @Test("normalize is timed at every size the plan budgets")
    func report() throws {
        let report = try JSCPerf.run(bundle: try Self.bundleSource(), repetitions: 5)

        // Machine-readable, so a device run can be piped somewhere and compared
        // with the Mac columns rather than read off a screenshot. `measure.sh`
        // parses exactly these lines.
        print("")
        for line in report.sampleLines(run: ProcessInfo.processInfo.processIdentifier) {
            print(line)
        }
        print("")
        print(report.text)

        #expect(report.measurements.count == JSCPerf.sizesInKilobytes.count)
        #expect(report.measurements.allSatisfy { $0.samples.count == 5 })
        #expect(report.loadMilliseconds > 0)

        guard let fifty = report.measurements.first(where: { $0.label == "50 kB" }) else {
            Issue.record("no 50 kB measurement")
            return
        }
        if report.jitEnabled {
            // A JIT means this is the simulator or an entitled Mac process.
            // Asserting the device budget here would be asserting nothing.
            print(
                "note: the JIT is enabled, so this is NOT the N3 go/no-go — run on a device"
            )
        } else {
            #expect(
                fifty.p95 < Self.budgetMilliseconds,
                "50 kB p95 \(fifty.p95) ms exceeds the \(Self.budgetMilliseconds) ms budget")
        }
    }

    @Test("the harness reports which JIT regime it measured")
    func regimeIsReported() throws {
        // Without this the numbers are unattributable, which is how the first
        // version of this spike ended up quoting an interpreter figure as if it
        // were the engine's speed.
        let report = try JSCPerf.run(bundle: try Self.bundleSource(), repetitions: 1)
        #expect(report.addLoopMilliseconds > 0)
        #expect(report.text.contains(report.jitEnabled ? "JIT is running" : "no JIT"))
    }
}
