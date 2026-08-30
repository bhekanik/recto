import Foundation

struct AppConfiguration: Equatable, Sendable {
    let convexURL: String
    let clerkPublishableKey: String

    init(bundle: Bundle = .main) throws {
        guard let convexURL = bundle.object(forInfoDictionaryKey: "RectoConvexURL") as? String,
              !convexURL.isEmpty,
              !convexURL.contains("$("),
              URL(string: convexURL)?.scheme == "https" else {
            throw AppConfigurationError.missingConvexURL
        }
        guard let clerkPublishableKey = bundle.object(
            forInfoDictionaryKey: "RectoClerkPublishableKey"
        ) as? String,
              !clerkPublishableKey.isEmpty,
              !clerkPublishableKey.contains("$(") else {
            throw AppConfigurationError.missingClerkPublishableKey
        }
        self.convexURL = convexURL
        self.clerkPublishableKey = clerkPublishableKey
    }

    init(convexURL: String, clerkPublishableKey: String) {
        self.convexURL = convexURL
        self.clerkPublishableKey = clerkPublishableKey
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
