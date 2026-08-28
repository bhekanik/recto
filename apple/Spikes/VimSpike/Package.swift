// swift-tools-version: 6.2
import PackageDescription

// N0c spike. Deliberately a SwiftPM package rather than an .xcodeproj: nothing
// here needs signing, entitlements or a bundle id, and `swift build` keeps the
// spike reproducible from a clean clone. The product code (N3/N5) will live in
// the app project.
let package = Package(
    name: "VimSpike",
    platforms: [.macOS(.v26)],
    targets: [
        .target(
            name: "RectoVim",
            resources: [.copy("Resources/recto-vim.js")]
        ),
        // Headless: runs the shared fixture suite and the latency benchmark.
        .executableTarget(
            name: "VimSpikeSuite",
            dependencies: ["RectoVim"],
            resources: [.copy("Resources/keystroke-suite.json")]
        ),
        // The NSTextView proof.
        .executableTarget(name: "VimSpikeApp", dependencies: ["RectoVim"]),
    ]
)
