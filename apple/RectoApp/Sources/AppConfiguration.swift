import Foundation

struct AppConfiguration: Equatable, Sendable {
    let convexURL: String
    let clerkPublishableKey: String

    init(bundle: Bundle = .main) throws {
        try self.init(values: bundle.infoDictionary ?? [:])
    }

    init(values: [String: Any]) throws {
        guard let convexURL = values["RectoConvexURL"] as? String,
              Self.isValidHTTPSURL(convexURL) else {
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

    static func isValidHTTPSURL(_ value: String) -> Bool {
        guard !value.contains("$("), let url = URL(string: value), url.scheme == "https",
              let host = url.host, url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil else { return false }
        return isValidHost(host)
    }

    static func isValidClerkPublishableKey(_ key: String) -> Bool {
        let prefixes = ["pk_test_", "pk_live_"]
        guard let prefix = prefixes.first(where: key.hasPrefix) else { return false }
        var encoded = String(key.dropFirst(prefix.count))
        guard !encoded.isEmpty,
              encoded.allSatisfy({ character in
                  character.isASCII
                      && (character.isLetter || character.isNumber || character == "-"
                          || character == "_")
              })
        else { return false }
        let urlSafePayload = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded = urlSafePayload
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              let decoded = String(data: data, encoding: .utf8),
              decoded.hasSuffix("$") else { return false }
        return isValidHost(String(decoded.dropLast()))
    }

    private static func isValidHost(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf8.count <= 253 else { return false }
        return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            guard (1...63).contains(label.utf8.count),
                  label.first?.isLetter == true || label.first?.isNumber == true,
                  label.last?.isLetter == true || label.last?.isNumber == true else {
                return false
            }
            return label.allSatisfy { character in
                character.isASCII
                    && (character.isLetter || character.isNumber || character == "-")
            }
        }
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
