import Foundation
import Testing

@testable import RectoHistory

@Suite("ULID")
struct ULIDTests {
  @Test("format matches lib/history/ulid.ts")
  func format() {
    let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    let id = ULIDGenerator().next(now: 1_756_000_000_000)
    #expect(id.count == 26)
    #expect(id.allSatisfy { alphabet.contains($0) })
    #expect(id.hasPrefix(ULIDGenerator.encodeTime(1_756_000_000_000)))
  }

  @Test("timestamps sort lexicographically")
  func timeOrdering() {
    let generator = ULIDGenerator()
    let earlier = generator.next(now: 1_756_000_000_000)
    let later = generator.next(now: 1_756_000_001_000)
    #expect(earlier < later)
  }

  @Test("ids minted in the same millisecond still sort in creation order")
  func monotonicWithinMillisecond() {
    let generator = ULIDGenerator()
    let ids = (0..<500).map { _ in generator.next(now: 1_756_000_000_000) }
    #expect(ids == ids.sorted())
    #expect(Set(ids).count == ids.count)
  }

  @Test("the random tail increments in base32 and reports overflow")
  func increment() {
    #expect(ULIDGenerator.increment(Array("0000000000000000")) == Array("0000000000000001"))
    #expect(ULIDGenerator.increment(Array("000000000000000Z")) == Array("0000000000000010"))
    #expect(ULIDGenerator.increment(Array("ZZZZZZZZZZZZZZZZ")) == nil)
  }

  @Test("clock going backwards does not produce a duplicate")
  func clockSkew() {
    let generator = ULIDGenerator()
    let first = generator.next(now: 1_756_000_001_000)
    let backwards = generator.next(now: 1_756_000_000_000)
    #expect(first != backwards)
    #expect(backwards < first)
  }
}
