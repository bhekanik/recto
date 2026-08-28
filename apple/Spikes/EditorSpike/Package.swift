// swift-tools-version: 6.0
import PackageDescription

// N0b spike: measure nodes-app/swift-markdown-engine (via the bhekanik fork) as
// the base of RectoEditor. Pinned to an exact revision so the numbers in the
// report are reproducible.
let package = Package(
    name: "EditorSpike",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(
            url: "https://github.com/bhekanik/swift-markdown-engine.git",
            revision: "08ff3c07b198ed639f595d0279ebac62c0410bc7"
        )
    ],
    targets: [
        .executableTarget(
            name: "EditorSpike",
            dependencies: [
                .product(name: "MarkdownEngine", package: "swift-markdown-engine")
            ],
            // The engine is a Swift 5 language-mode package; the spike matches it
            // rather than paying for a strict-concurrency port it does not need.
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
