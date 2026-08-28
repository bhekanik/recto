// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoSync",
  platforms: [.macOS(.v26), .iOS(.v26)],
  products: [
    .library(name: "RectoSync", targets: ["RectoSync"]),
    // A faithful in-memory Convex stand-in, shared by this package's tests and
    // RectoCore's. Kept out of RectoSync so no test double ships in the app.
    .library(name: "RectoSyncTesting", targets: ["RectoSyncTesting"]),
  ],
  dependencies: [
    .package(url: "https://github.com/get-convex/convex-swift.git", from: "0.8.1"),
    .package(path: "../RectoStore"),
    .package(path: "../RectoAuth"),
    .package(path: "../RectoHistory"),
  ],
  targets: [
    .target(
      name: "RectoSync",
      dependencies: [
        .product(name: "ConvexMobile", package: "convex-swift"),
        "RectoStore",
        "RectoAuth",
        "RectoHistory",
      ],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .target(
      name: "RectoSyncTesting",
      dependencies: ["RectoSync", "RectoHistory"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "RectoSyncTests",
      dependencies: ["RectoSync", "RectoSyncTesting"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
