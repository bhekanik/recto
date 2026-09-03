import Foundation

/// `recto://document/<convexId>` and `<webOrigin>/?doc=<convexId>`.
enum DocumentLink {
    static let scheme = "recto"
    static let host = "document"
    static let queryParameter = "doc"

    static func parse(_ string: String) -> String? {
        guard let url = URL(string: string) else { return nil }
        return parse(url)
    }

    static func parse(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil
        else { return nil }

        let convexId: String?
        if url.host?.lowercased() == host {
            let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
            guard parts.count == 1 else { return nil }
            convexId = String(parts[0])
        } else if url.host == nil || url.host == "" {
            let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
            guard parts.count == 2, parts[0].lowercased() == host else { return nil }
            convexId = String(parts[1])
        } else {
            return nil
        }

        guard let convexId, !convexId.isEmpty,
              !convexId.contains("/"), !convexId.contains(" ")
        else { return nil }
        return convexId.removingPercentEncoding ?? convexId
    }

    static func appURL(convexId: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = "/\(convexId)"
        return components.url
    }

    static func webURL(origin: URL, convexId: String) -> URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.path.isEmpty { components.path = "/" }
        components.queryItems = [URLQueryItem(name: queryParameter, value: convexId)]
        components.fragment = nil
        return components.url
    }
}

enum WebHandoff {
    static func isEnabled(convexId: String?, webOrigin: URL?) -> Bool {
        convexId != nil && !(convexId?.isEmpty ?? true) && webOrigin != nil
    }

    static func disabledReason(convexId: String?, webOrigin: URL?) -> String {
        if webOrigin == nil {
            return "This build has no web URL configured."
        }
        if convexId == nil || convexId?.isEmpty == true {
            return "This document hasn't synced to Recto on the web yet."
        }
        return "Open in web app"
    }
}
