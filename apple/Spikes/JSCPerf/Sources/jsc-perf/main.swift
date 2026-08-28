import Foundation
import JSCPerfCore

// macOS runner. Its reason for existing is the second invocation in
// `measure.sh`: signed with the hardened runtime and without
// `com.apple.security.cs.allow-jit`, macOS refuses JIT pages and JavaScriptCore
// falls back to the interpreter — the same regime a third-party app gets on an
// iPhone. That makes it the closest proxy for a device number available without
// a device.
//
//   jsc-perf <recto-core.js> [repetitions]

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(
        Data("usage: jsc-perf <recto-core.js> [repetitions]\n".utf8))
    exit(2)
}
let repetitions = arguments.count >= 3 ? Int(arguments[2]) ?? 5 : 5

/// What this process is actually allowed to do, since that is the variable under
/// test. Reported rather than assumed: a run whose entitlements are not recorded
/// cannot be compared with another one.
func entitlements() -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    process.arguments = ["-d", "--entitlements", "-", "--xml", Bundle.main.executablePath ?? ""]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = Pipe()
    guard (try? process.run()) != nil else { return "unknown (codesign unavailable)" }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(data: data, encoding: .utf8) ?? ""
    let keys = ["com.apple.security.cs.allow-jit", "com.apple.security.app-sandbox"]
        .filter { text.contains($0) }
    return keys.isEmpty ? "none" : keys.joined(separator: ", ")
}

do {
    let bundle = try String(contentsOfFile: arguments[1], encoding: .utf8)
    print("entitlements \(entitlements())")
    let report = try JSCPerf.run(bundle: bundle, repetitions: repetitions)
    print(report.text)
    // The N3 budget: 50 kB normalize under one second.
    if let fifty = report.measurements.first(where: { $0.label == "50 kB" }) {
        let verdict = fifty.p95 < 1000 ? "PASS" : "FAIL"
        print(
            String(
                format: "budget      50 kB p95 < 1000 ms: %@ (%.0f ms)", verdict, fifty.p95))
    }
} catch {
    FileHandle.standardError.write(Data("jsc-perf: \(error)\n".utf8))
    exit(1)
}
