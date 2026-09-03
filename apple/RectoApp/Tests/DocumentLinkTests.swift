import Foundation
import Testing

@testable import Recto

@Suite("web ↔ Mac document links")
struct DocumentLinkTests {
    // MARK: recto:// parsing

    @Test("recto://document/<id> yields the convex id")
    func parsesDocumentLinks() {
        #expect(DocumentLink.parse("recto://document/k57handoff0000000") == "k57handoff0000000")
        #expect(DocumentLink.parse("RECTO://DOCUMENT/k57handoff0000000") == "k57handoff0000000")
        // macOS normalizes the host into the path when there is no authority.
        #expect(DocumentLink.parse("recto:/document/k57handoff0000000") == "k57handoff0000000")
    }

    @Test("garbage is rejected without throwing")
    func rejectsGarbage() {
        let rejected = [
            "",
            "not a url",
            "https://example.com/documents/k57handoff0000000",
            "recto://other/k57handoff0000000",
            "recto://document",
            "recto://document/",
            "recto://document/k57handoff0000000/extra",
            "recto://document/k57handoff0000000?x=1",
            "recto://document/k57handoff0000000#frag",
            "recto://user:pass@document/k57handoff0000000",
            "recto://document/with space",
            "recto://document/../../etc",
        ]
        for string in rejected {
            #expect(DocumentLink.parse(string) == nil, "should reject \(string)")
        }
    }

    @Test("the built URL round-trips through the parser")
    func roundTrips() {
        let url = DocumentLink.appURL(convexId: "k57handoff0000000")
        #expect(url?.absoluteString == "recto://document/k57handoff0000000")
        #expect(DocumentLink.parse(url!) == "k57handoff0000000")
    }

    // MARK: web URL building

    @Test("the web URL is <origin>/?doc=<convexId>")
    func buildsWebURL() throws {
        let plain = URL(string: "https://recto.example")!
        let url = DocumentLink.webURL(origin: plain, convexId: "k57handoff0000000")
        #expect(url?.absoluteString == "https://recto.example/?doc=k57handoff0000000")
        // Configuration accepts only origins, so a trailing slash is the one
        // spelling variation that can occur.
        let slashed = URL(string: "https://recto.example/")!
        let slashedURL = DocumentLink.webURL(origin: slashed, convexId: "k57handoff0000000")
        #expect(slashedURL?.absoluteString == "https://recto.example/?doc=k57handoff0000000")
    }

    // MARK: gating

    @Test("the handoff needs both a convex id and a configured web origin")
    func handoffGating() {
        let origin = URL(string: "https://recto.example")
        #expect(!WebHandoff.isEnabled(convexId: nil, webOrigin: origin))
        #expect(!WebHandoff.isEnabled(convexId: "", webOrigin: origin))
        #expect(!WebHandoff.isEnabled(convexId: "k57handoff0000000", webOrigin: nil))
        #expect(WebHandoff.isEnabled(convexId: "k57handoff0000000", webOrigin: origin))
        // A document with no convex id yet is exactly the "file document →
        // disabled" case: local-only, so the web has no page to open.
        #expect(WebHandoff.disabledReason(convexId: nil, webOrigin: origin).contains("synced"))
        #expect(WebHandoff.disabledReason(convexId: "k57handoff0000000", webOrigin: nil).contains("web URL"))
    }

    // MARK: Info.plist — the scheme the app registers with Launch Services

    @Test("the app declares the recto scheme")
    func declaresURLScheme() throws {
        let urlTypes = try #require(
            Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]]
        )
        let recto = try #require(urlTypes.first { type in
            (type["CFBundleURLSchemes"] as? [String])?.contains("recto") == true
        })
        #expect(recto["CFBundleTypeRole"] as? String == "Editor")
        #expect(recto["CFBundleURLName"] as? String == "Recto document link")
    }
}
