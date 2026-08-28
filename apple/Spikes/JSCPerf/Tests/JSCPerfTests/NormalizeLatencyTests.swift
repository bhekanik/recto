import Foundation
import Testing

@testable import JSCPerfCore

/// The same measurement, runnable on an iOS simulator with
/// `xcodebuild test -destination 'platform=iOS Simulator,…'`.
///
/// The simulator is a Mac process and therefore **has the JIT**, so these
/// numbers are an upper bound on a device, not the go/no-go. The suite reports
/// what the JIT probe found so the output cannot be mistaken for a device run.
@Suite("normalize latency")
struct NormalizeLatencyTests {
    /// The simulator shares the host filesystem, so the bundle is read from the
    /// checkout rather than staged as a resource.
    static let bundlePath: String = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
            .appending(path: "packages/recto-core-js/dist/recto-core.js").path
    }()

    @Test("normalize is timed at every size the plan budgets")
    func report() throws {
        guard FileManager.default.fileExists(atPath: Self.bundlePath) else {
            Issue.record("run `bun run core:build` first (\(Self.bundlePath))")
            return
        }
        let bundle = try String(contentsOfFile: Self.bundlePath, encoding: .utf8)
        let report = try JSCPerf.run(bundle: bundle)
        print("\n\(report.text)\n")

        #expect(report.measurements.count == JSCPerf.sizesInKilobytes.count)
        // Not a budget assertion: the budget is a device number and this may be
        // running on a simulator. Only that the harness produced real work.
        #expect(report.measurements.allSatisfy { $0.milliseconds > 0 })
        #expect(report.loadMilliseconds > 0)
    }
}
