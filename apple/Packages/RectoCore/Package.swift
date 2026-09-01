// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoCore",
  platforms: [.macOS("26.2"), .iOS(.v26)],
  products: [
    .library(name: "RectoCore", targets: ["RectoCore"])
  ],
  dependencies: [
    .package(path: "../RectoStore"),
    .package(path: "../RectoSync"),
    .package(path: "../RectoAuth"),
    .package(path: "../RectoHistory"),
    .package(path: "../RectoCoreJS"),
    .package(url: "https://github.com/clerk/clerk-ios.git", from: "1.5.0"),
  ],
  targets: [
    .target(
      name: "RectoCore",
      dependencies: ["RectoStore", "RectoSync", "RectoAuth", "RectoHistory", "RectoCoreJS"],
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
    // Live tests against a real Convex deployment. They skip themselves with a
    // clear message unless RECTO_CONVEX_URL and RECTO_CLERK_PUBLISHABLE_KEY are
    // set, so `swift test` stays hermetic by default.
    .testTarget(
      name: "RectoIntegrationTests",
      dependencies: [
        "RectoCore",
        .product(name: "ClerkKit", package: "clerk-ios"),
      ],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
