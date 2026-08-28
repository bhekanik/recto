// swift-tools-version: 6.2
import PackageDescription

/// The vim layer: `packages/recto-vim-js` in a `JSContext`, plus the text-view
/// adapters that replay its edits (plan 023 §1.4, D-N6).
///
/// `Sources/RectoVim/JS/recto-vim.js` is build output installed by
/// `apple/scripts/copy-js-bundles.sh`; see that script and the package README.
/// The directory is `JS/` and not `Resources/` because on iOS a resource bundle
/// is flat, and a top-level `Resources` directory inside it makes `codesign`
/// reject the bundle as "unrecognized, invalid, or unsuitable".
let package = Package(
    name: "RectoVim",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "RectoVim", targets: ["RectoVim"])
    ],
    targets: [
        .target(
            name: "RectoVim",
            resources: [.copy("JS")]
        ),
        .testTarget(
            name: "RectoVimTests",
            dependencies: ["RectoVim"]
        ),
        // Per-key latency against the < 2 ms budget. Opt-in (RECTO_VIM_PERF=1):
        // it builds a 950 kB document and runs thousands of keys.
        .testTarget(
            name: "RectoVimPerfTests",
            dependencies: ["RectoVim"]
        ),
    ]
)
