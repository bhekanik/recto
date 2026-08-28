// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoHistory",
  platforms: [.macOS(.v26), .iOS(.v26)],
  products: [
    .library(name: "RectoHistory", targets: ["RectoHistory"])
  ],
  targets: [
    .target(
      name: "RectoHistory",
      swiftSettings: [.swiftLanguageMode(.v6), .strictMemorySafety()]
    ),
    .testTarget(
      name: "RectoHistoryTests",
      dependencies: ["RectoHistory"],
      resources: [.copy("Fixtures")],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
