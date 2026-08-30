import Foundation

struct AppConfiguration: Equatable, Sendable {
    let convexURL: String
    let clerkPublishableKey: String

    init(bundle: Bundle = .main) throws {
        try self.init(values: bundle.infoDictionary ?? [:])
    }

    init(values: [String: Any]) throws {
        guard let convexURL = values["RectoConvexURL"] as? String,
              !convexURL.isEmpty,
              !convexURL.contains("$("),
              URL(string: convexURL)?.scheme == "https" else {
            throw AppConfigurationError.missingConvexURL
        }
        guard let clerkPublishableKey = values["RectoClerkPublishableKey"] as? String,
              Self.isValidClerkPublishableKey(clerkPublishableKey) else {
            throw AppConfigurationError.missingClerkPublishableKey
        }
        self.convexURL = convexURL
        self.clerkPublishableKey = clerkPublishableKey
    }

    init(convexURL: String, clerkPublishableKey: String) {
        self.convexURL = convexURL
        self.clerkPublishableKey = clerkPublishableKey
    }

    private static func isValidClerkPublishableKey(_ key: String) -> Bool {
        let prefixes = ["pk_test_", "pk_live_"]
        guard let prefix = prefixes.first(where: key.hasPrefix) else { return false }
        var encoded = String(key.dropFirst(prefix.count))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              let decoded = String(data: data, encoding: .utf8),
              decoded.hasSuffix("$"),
              let url = URL(string: "https://\(decoded.dropLast())"),
              url.host() != nil else { return false }
        return true
    }
}

enum AppConfigurationError: LocalizedError, Equatable {
    case missingConvexURL
    case missingClerkPublishableKey

    var errorDescription: String? {
        switch self {
        case .missingConvexURL:
            "This Recto build has no HTTPS Convex URL."
        case .missingClerkPublishableKey:
            "This Recto build has no Clerk publishable key."
        }
    }
}
