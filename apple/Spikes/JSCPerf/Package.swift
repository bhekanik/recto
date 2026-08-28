// swift-tools-version: 6.2
import PackageDescription

/// N3 go/no-go: how long a whole-document `RectoCore` call takes on an iPhone.
///
/// Two products, because the interesting number cannot be measured on this
/// machine directly:
///
/// - `JSCPerfTests` runs on the iOS simulator and on macOS. The simulator is a
///   Mac process, so it gets the JIT and its numbers are an **upper bound**, not
///   the answer. See README.md for the device invocation.
/// - `jsc-perf` is a macOS executable that can be signed with the hardened
///   runtime *without* `com.apple.security.cs.allow-jit`, which is the closest
///   proxy for a device available without a device.
let package = Package(
    name: "JSCPerf",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .executable(name: "jsc-perf", targets: ["jsc-perf"])
    ],
    targets: [
        .target(name: "JSCPerfCore"),
        .executableTarget(name: "jsc-perf", dependencies: ["JSCPerfCore"]),
        .testTarget(name: "JSCPerfTests", dependencies: ["JSCPerfCore"]),
    ]
)
