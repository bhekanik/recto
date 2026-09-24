// swift-tools-version: 6.2
import PackageDescription

// RectoEditor — Recto's Markdown editor: TextKit 2 only, the Markdown string
// IS the document, syntax markers are hidden rather than removed.
//
// The styling/layout engine is a fork of nodes-app/swift-markdown-engine,
// pinned to a revision on the `recto` branch. The fork is where parser and
// dialect work lands; this package is Recto's configuration of it — the type
// scale, the theme slots, the three presentations, and the document-scoped
// storage the app's DocumentSession drives.
let package = Package(
    name: "RectoEditor",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "RectoEditor", targets: ["RectoEditor"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/bhekanik/swift-markdown-engine",
            revision: "d0e7cdebddb573ec2e1c19a285e33f02c2090225"
        ),
        .package(
            url: "https://github.com/smittytone/HighlighterSwift",
            exact: "3.1.0"
        ),
        // The vim engine (JavaScriptCore) and its host protocols. The `.vim`
        // presentation is raw rendering plus its key interception.
        .package(path: "../RectoVim"),
    ],
    targets: [
        .target(
            name: "RectoEditor",
            dependencies: [
                .product(name: "MarkdownEngine", package: "swift-markdown-engine"),
                .product(name: "Highlighter", package: "HighlighterSwift"),
                .product(name: "RectoVim", package: "RectoVim"),
            ],
            resources: [.process("Resources")],
            swiftSettings: [
                // Every entry point is an AppKit delegate callback, a SwiftUI
                // update pass or a draw — the same argument the engine makes.
                .defaultIsolation(MainActor.self),
                .swiftLanguageMode(.v5),
            ]
        ),
        .testTarget(
            name: "RectoEditorTests",
            dependencies: [
                "RectoEditor",
                .product(name: "RectoVimFixtures", package: "RectoVim"),
            ],
            resources: [.copy("Corpus"), .copy("Snapshots")],
            swiftSettings: [
                .defaultIsolation(MainActor.self),
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
