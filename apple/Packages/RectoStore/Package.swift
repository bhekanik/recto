// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoStore",
  platforms: [.macOS(.v26), .iOS(.v26)],
  products: [
    .library(name: "RectoStore", targets: ["RectoStore"])
  ],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    .package(path: "../RectoHistory"),
  ],
  targets: [
    .target(
      name: "RectoStore",
      dependencies: [
        .product(name: "GRDB", package: "GRDB.swift"),
        "RectoHistory",
      ],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "RectoStoreTests",
      dependencies: ["RectoStore"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
