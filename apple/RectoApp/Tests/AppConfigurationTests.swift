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
    }

    @Test(arguments: ["", "wrong_prefix", "pk_test_not-base64"])
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
}
