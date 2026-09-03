import Foundation
import Testing

@testable import Recto

@Suite("app configuration")
struct AppConfigurationTests {
    private let validKey = "pk_test_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk"

    @Test("validates the values embedded into the application bundle")
    func acceptsValidConfiguration() throws {
        let configuration = try AppConfiguration(values: [
            "RectoConvexURL": "https://example.convex.cloud",
            "RectoClerkPublishableKey": validKey,
        ])
        #expect(configuration.convexURL == "https://example.convex.cloud")
        #expect(configuration.webURL == nil)
    }

    @Test("missing or unresolved web URL disables Open in web")
    func optionalWebURL() throws {
        let missing = try AppConfiguration(values: [
            "RectoConvexURL": "https://example.convex.cloud",
            "RectoClerkPublishableKey": validKey,
        ])
        #expect(missing.webURL == nil)

        let unresolved = try AppConfiguration(values: [
            "RectoConvexURL": "https://example.convex.cloud",
            "RectoClerkPublishableKey": validKey,
            "RectoWebURL": "$(RECTO_WEB_URL)",
        ])
        #expect(unresolved.webURL == nil)

        let empty = try AppConfiguration(values: [
            "RectoConvexURL": "https://example.convex.cloud",
            "RectoClerkPublishableKey": validKey,
            "RectoWebURL": "",
        ])
        #expect(empty.webURL == nil)
    }

    @Test("accepts an HTTPS web origin")
    func acceptsWebURL() throws {
        let configuration = try AppConfiguration(values: [
            "RectoConvexURL": "https://example.convex.cloud",
            "RectoClerkPublishableKey": validKey,
            "RectoWebURL": "https://recto.example",
        ])
        #expect(configuration.webURL == "https://recto.example")
    }

    @Test(arguments: ["https://", "http://example.com", "https://example.com/path?x=1"])
    func rejectsMalformedWebURL(_ url: String) {
        #expect(throws: AppConfigurationError.invalidWebURL) {
            try AppConfiguration(values: [
                "RectoConvexURL": "https://example.convex.cloud",
                "RectoClerkPublishableKey": validKey,
                "RectoWebURL": url,
            ])
        }
    }

    @Test(arguments: [
        "", "wrong_prefix", "pk_test_", "pk_test_not-base64", "pk_live_$(MISSING)",
        "pk_test_aG9zdC9wYXRoJA",
    ])
    func rejectsMalformedClerkKey(_ key: String) {
        #expect(throws: AppConfigurationError.missingClerkPublishableKey) {
            try AppConfiguration(values: [
                "RectoConvexURL": "https://example.convex.cloud",
                "RectoClerkPublishableKey": key,
            ])
        }
    }

    @Test("rejects unresolved build settings")
    func rejectsUnresolvedSettings() {
        #expect(throws: AppConfigurationError.missingConvexURL) {
            try AppConfiguration(values: [
                "RectoConvexURL": "$(RECTO_CONVEX_URL)",
                "RectoClerkPublishableKey": validKey,
            ])
        }
    }

    @Test(arguments: ["", "https://", "http://example.com", "https://$(MISSING)"])
    func rejectsMalformedConvexURL(_ url: String) {
        #expect(throws: AppConfigurationError.missingConvexURL) {
            try AppConfiguration(values: [
                "RectoConvexURL": url,
                "RectoClerkPublishableKey": validKey,
            ])
        }
    }

    @Test("archive validator matches runtime configuration validation")
    func archiveValidationParity() throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
            .appending(path: "recto-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
        let contents = temporaryDirectory
            .appending(path: "Products/Applications/Recto.app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist = contents.appending(path: "Info.plist")
        let script = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "scripts/validate-archive-config.sh")

        func validate(convexURL: String, clerkKey: String, webURL: String) throws -> Int32 {
            let data = try PropertyListSerialization.data(
                fromPropertyList: [
                    "RectoConvexURL": convexURL,
                    "RectoClerkPublishableKey": clerkKey,
                    "RectoWebURL": webURL,
                ],
                format: .xml,
                options: 0
            )
            try data.write(to: plist)
            let process = Process()
            process.executableURL = script
            process.arguments = [temporaryDirectory.path]
            process.standardOutput = Pipe()
            process.standardError = Pipe()
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }

        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: validKey,
            webURL: "https://recto.example") == 0)
        #expect(try validate(convexURL: "https://", clerkKey: validKey, webURL: "https://recto.example") != 0)
        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: "pk_test_",
            webURL: "https://recto.example") != 0)
        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: "pk_live_$(MISSING)",
            webURL: "https://recto.example") != 0)
        #expect(try validate(
            convexURL: "https://example.convex.cloud",
            clerkKey: "pk_test_aG9zdC9wYXRoJA", webURL: "https://recto.example") != 0)
        // The web URL follows the same rule as the Convex URL: present, HTTPS,
        // resolved. An archive without one ships the handoff disabled.
        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: validKey,
            webURL: "http://recto.example") != 0)
        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: validKey,
            webURL: "$(RECTO_WEB_URL)") != 0)
        #expect(try validate(
            convexURL: "https://example.convex.cloud", clerkKey: validKey,
            webURL: "") != 0)
    }
}
