// swift-tools-version: 6.0
import PackageDescription

/// N0d parity spike: runs `dist/recto-core.js` inside a real `JSContext` over the
/// same fixtures the web tests use, and reports load / per-call timings.
let package = Package(
	name: "recto-core-parity",
	platforms: [.macOS(.v14)],
	products: [
		.executable(name: "recto-core-parity", targets: ["RectoCoreParity"])
	],
	targets: [
		.executableTarget(name: "RectoCoreParity")
	]
)
