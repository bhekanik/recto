import ConvexMobile
import Foundation
import Testing

@testable import RectoSync

/// The generic call surface: what goes on the wire for a `ConvexValue`, and how
/// a server `ConvexError` comes back.
@Suite("generic Convex calls")
struct ConvexAPITests {
  private func wire(_ value: ConvexValue) throws -> String {
    try value.encodable?.convexEncode() ?? "null"
  }

  @Test("numbers go out as floats, never as $integer")
  func numbersAreFloats() throws {
    // `v.number()` rejects Convex's `$integer`; an Int slipping through is the
    // N0a spike's sharpest trap.
    #expect(try wire(.number(3)) == "3")
    #expect(try wire(3) == "3")
    #expect(try !wire(.number(3)).contains("$integer"))
  }

  @Test("objects and arrays nest, with literals")
  func nesting() throws {
    let value: ConvexValue = ["documentId": "d1", "limit": 5, "tags": ["a", true, .null]]
    let decoded = try JSONSerialization.jsonObject(with: Data(wire(value).utf8)) as? [String: Any]
    #expect(decoded?["documentId"] as? String == "d1")
    #expect(decoded?["limit"] as? Double == 5)
    let tags = decoded?["tags"] as? [Any]
    #expect(tags?.count == 3)
    #expect(tags?[1] as? Bool == true)
    #expect(tags?[2] is NSNull)
  }

  @Test("absent is not null: arguments carry only the keys given")
  func absentKeys() throws {
    let args = ConvexValue.arguments(["a": "x", "b": nil])
    #expect(args.keys.sorted() == ["a"])
  }

  @Test("a ConvexError with {code, message} becomes a RemoteCallError")
  func errorMapping() {
    let error = RemoteCallError(
      convexErrorData: #"{"code":"ai_consent_required","message":"Accept first."}"#)
    #expect(error?.code == "ai_consent_required")
    #expect(error?.message == "Accept first.")
    #expect(RemoteCallError(convexErrorData: #""plain string""#)?.message == "plain string")
  }
}
