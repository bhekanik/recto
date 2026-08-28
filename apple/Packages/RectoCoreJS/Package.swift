// swift-tools-version: 6.2
import PackageDescription

/// The shared JS core (plan 023 D-N3, §1.5) and the two Swift ports that stand
/// in for it on per-keystroke paths.
///
/// `Sources/RectoCoreJS/JS/recto-core.js` is build output, not source:
/// `apple/scripts/copy-js-bundles.sh` puts it there after `bun run core:build`
/// and checks its sha256 against the package's `manifest.json`. Without it the
/// package still builds and `RectoCore.init` throws `bundleMissing` with the
/// command to run, which is a better failure than a SwiftPM resource error.
///
/// The directory is `JS/` and not `Resources/`: on iOS a resource bundle is
/// flat, and a top-level directory called `Resources` inside it makes
/// `codesign` reject the bundle as "unrecognized, invalid, or unsuitable".
let package = Package(
    name: "RectoCoreJS",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "RectoCoreJS", targets: ["RectoCoreJS"])
    ],
    targets: [
        .target(
            name: "RectoCoreJS",
            resources: [.copy("JS")]
        ),
        .testTarget(
            name: "RectoCoreJSTests",
            dependencies: ["RectoCoreJS"]
        ),
        // Latency, not correctness. Opt-in: these run the whole corpus at four
        // document sizes and take tens of seconds, which is noise on a shared
        // runner. Set RECTO_CORE_PERF=1 to enable.
        .testTarget(
            name: "RectoCoreJSPerfTests",
            dependencies: ["RectoCoreJS"]
        ),
    ]
)
