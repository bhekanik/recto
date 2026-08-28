import Foundation
import JSCPerfCore

// macOS runner. Its reason for existing is the *second* invocation in the
// README: signed with the hardened runtime and without
// `com.apple.security.cs.allow-jit`, macOS refuses JIT pages and JavaScriptCore
// falls back to the interpreter — the same regime a third-party app gets on an
// iPhone. That makes it the closest proxy for the device number available
// without a device.

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: jsc-perf <recto-core.js>\n".utf8))
    exit(2)
}

do {
    let bundle = try String(contentsOfFile: arguments[1], encoding: .utf8)
    let report = try JSCPerf.run(bundle: bundle)
    print(report.text)
    // The N3 budget: 50 kB normalize under one second.
    if let fifty = report.measurements.first(where: { $0.label == "50 kB" }) {
        let verdict = fifty.milliseconds < 1000 ? "PASS" : "FAIL"
        print(String(format: "budget      50 kB < 1000 ms: %@ (%.0f ms)", verdict, fifty.milliseconds))
    }
} catch {
    FileHandle.standardError.write(Data("jsc-perf: \(error)\n".utf8))
    exit(1)
}
