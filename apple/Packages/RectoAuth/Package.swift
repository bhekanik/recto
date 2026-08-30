// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RectoAuth",
  platforms: [.macOS("26.2"), .iOS(.v26)],
  products: [
    .library(name: "RectoAuth", targets: ["RectoAuth"])
  ],
  dependencies: [
    .package(url: "https://github.com/clerk/clerk-ios.git", from: "1.5.0"),
    .package(url: "https://github.com/get-convex/convex-swift.git", from: "0.8.1"),
    .package(path: "../RectoStore"),
  ],
  targets: [
    .target(
      name: "RectoAuth",
      dependencies: [
        .product(name: "ClerkKit", package: "clerk-ios"),
        .product(name: "ConvexMobile", package: "convex-swift"),
        "RectoStore",
      ],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "RectoAuthTests",
      dependencies: ["RectoAuth"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
