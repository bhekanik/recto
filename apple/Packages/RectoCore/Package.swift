// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoCore",
  platforms: [.macOS(.v26), .iOS(.v26)],
  products: [
    .library(name: "RectoCore", targets: ["RectoCore"])
  ],
  dependencies: [
    .package(path: "../RectoStore"),
    .package(path: "../RectoSync"),
    .package(path: "../RectoAuth"),
    .package(path: "../RectoHistory"),
  ],
  targets: [
    .target(
      name: "RectoCore",
      dependencies: ["RectoStore", "RectoSync", "RectoAuth", "RectoHistory"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "RectoCoreTests",
      dependencies: [
        "RectoCore",
        .product(name: "RectoSyncTesting", package: "RectoSync"),
      ],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
