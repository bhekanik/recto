import Foundation
import Testing

@testable import RectoHistory

struct PatchCases: Decodable {
  struct Case: Decodable {
    let parent: String
    let next: String
    let patch: String
    let applied: String
    let label: String
  }
  let source: String
  let cases: [Case]
}

@Suite("patch parity with lib/history/patch.ts")
struct PatchTests {
  @Test("computePatch encodes exactly what the web encodes")
  func computeMatchesWeb() throws {
    let fixture: PatchCases = try Fixtures.load("patch-cases")
    #expect(!fixture.cases.isEmpty)
    for testCase in fixture.cases {
      let patch = computePatch(testCase.parent, testCase.next)
      #expect(
        patch.encoded == testCase.patch,
        "\(testCase.parent.debugDescription) → \(testCase.next.debugDescription)")
    }
  }

  @Test("applyPatch round-trips every fixture pair")
  func applyRoundTrips() throws {
    let fixture: PatchCases = try Fixtures.load("patch-cases")
    for testCase in fixture.cases {
      let applied = try applyPatch(testCase.parent, patchRaw: testCase.patch)
      #expect(applied == testCase.next)
      #expect(applied == testCase.applied)
    }
  }

  @Test("node labels match the web")
  func labels() throws {
    let fixture: PatchCases = try Fixtures.load("patch-cases")
    for testCase in fixture.cases {
      #expect(nodeLabel(patch: testCase.patch, parentNodeId: "root") == testCase.label)
    }
  }

  @Test("a patch boundary inside a surrogate pair survives the round trip")
  func loneSurrogate() throws {
    let patch = computePatch("😀", "😁")
    // The common prefix is the HIGH surrogate: from 1, and `insert` is a lone
    // LOW surrogate that no Swift.String can hold.
    #expect(patch.from == 1)
    #expect(patch.to == 2)
    #expect(patch.insert.count == 1)
    #expect(patch.insert.isWellFormed == false)
    #expect(patch.encoded == #"{"from":1,"to":2,"insert":"\ude01"}"#)

    let decoded = try TextPatch.decode(patch.encoded)
    #expect(decoded == patch)
    #expect(try applyPatch("😀", patchRaw: patch.encoded) == "😁")
  }

  @Test("offsets are UTF-16 code units, not Characters or scalars")
  func utf16Offsets() {
    // "👨‍👩‍👧" is one Character, 3 scalars, 8 UTF-16 code units.
    let family = "👨‍👩‍👧"
    #expect(family.count == 1)
    #expect(family.unicodeScalars.count == 5)
    #expect(JSString(family).count == 8)

    let patch = computePatch("x\(family)y", "x\(family)z")
    #expect(patch.from == 9)
    #expect(patch.to == 10)
    #expect(patch.insert == JSString("z"))
  }

  @Test("JSON escaping matches JSON.stringify")
  func jsonEscaping() {
    #expect(JSString("a\"b\\c").jsonEncoded == #""a\"b\\c""#)
    #expect(JSString("tab\tnew\nret\r").jsonEncoded == #""tab\tnew\nret\r""#)
    #expect(JSString("\u{0}\u{1F}").jsonEncoded == #""\u0000\u001f""#)
    // A slash is NOT escaped and non-ASCII is emitted raw.
    #expect(JSString("a/b é 😀").jsonEncoded == "\"a/b é 😀\"")
  }

  @Test("malformed patch payloads are rejected, not silently applied")
  func malformed() {
    #expect(throws: PatchDecodingError.self) { try TextPatch.decode("not json") }
    #expect(throws: PatchDecodingError.self) { try TextPatch.decode(#"{"from":0,"to":0}"#) }
    #expect(throws: PatchDecodingError.self) { try TextPatch.decode(#"{"from":0,"to":0,"insert":"a"#) }
  }
}
