import Foundation

/// `recto://document/<convexId>` and `<webOrigin>/?doc=<convexId>`. The app
/// link may carry the writer's place from the web: `?at=<offset>&ctx=<text>`.
enum DocumentLink {
    static let scheme = "recto"
    static let host = "document"
    static let queryParameter = "doc"

    /// Where the caret was on the web: a UTF-16 offset into the canonical
    /// Markdown, and the text just before it (`macAppDocumentURL`).
    struct Caret: Equatable, Sendable {
        let at: Int
        let context: String

        /// The caret's place in `markdown`: `at` when the text before it still
        /// reads `context`; else just after the occurrence of `context` nearest
        /// `at` (this Mac's copy may be a sync behind or ahead); else `at`.
        func location(in markdown: String) -> Int {
            let text = markdown as NSString
            let at = min(max(self.at, 0), text.length)
            let length = (context as NSString).length
            guard length > 0 else { return at }
            if at >= length, text.substring(with: NSRange(location: at - length, length: length)) == context {
                return at
            }
            var best: Int?
            var search = NSRange(location: 0, length: text.length)
            while true {
                let found = text.range(of: context, options: .literal, range: search)
                guard found.location != NSNotFound else { break }
                let end = NSMaxRange(found)
                if best.map({ abs($0 - at) > abs(end - at) }) ?? true { best = end }
                let next = found.location + 1
                guard next < text.length else { break }
                search = NSRange(location: next, length: text.length - next)
            }
            return best ?? at
        }
    }

    /// A parsed app link: the document, and the caret when the link has one.
    struct Target: Equatable, Sendable {
        let convexId: String
        let caret: Caret?
    }

    static func parse(_ string: String) -> String? {
        guard let url = URL(string: string) else { return nil }
        return parse(url)
    }

    static func parse(_ url: URL) -> String? {
        target(url)?.convexId
    }

    static func target(_ url: URL) -> Target? {
        guard url.scheme?.lowercased() == scheme,
              url.user == nil, url.password == nil,
              url.fragment == nil,
              let linkCaret = caret(from: url)
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
        return Target(convexId: convexId.removingPercentEncoding ?? convexId, caret: linkCaret)
    }

    /// The link's query: none, or exactly `at` (a non-negative integer) with
    /// an optional `ctx`. Anything else rejects the link. The outer optional
    /// is the verdict; the inner one is whether a caret came with it.
    private static func caret(from url: URL) -> Caret?? {
        guard url.query != nil else { return .some(nil) }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.allSatisfy({ ["at", "ctx"].contains($0.name) }),
              items.filter({ $0.name == "at" }).count == 1,
              items.filter({ $0.name == "ctx" }).count <= 1,
              let raw = items.first(where: { $0.name == "at" })?.value,
              let at = Int(raw), at >= 0
        else { return nil }
        let context = items.first(where: { $0.name == "ctx" })?.value ?? ""
        return .some(Caret(at: at, context: context))
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
