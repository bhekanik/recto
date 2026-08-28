import Foundation
import Synchronization

/// Crockford base32, the same alphabet `lib/history/ulid.ts` uses.
private let ulidAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
private let ulidTimeLength = 10
private let ulidRandomLength = 16

/// 26-character ULID: 10 characters of millisecond timestamp + 16 random,
/// matching the web's format exactly so node ids sort identically on both
/// clients.
///
/// Unlike the web's generator this one is **monotonic**: two ids minted in the
/// same millisecond still sort in creation order, because the random tail is
/// incremented instead of redrawn. A native session mints ids far faster than
/// the web's 500 ms grouping ever did (undo/redo, outbox replay, offline
/// batches), and the history tree orders siblings by nodeId.
public final class ULIDGenerator: Sendable {
  private struct Last: Sendable {
    var millis: UInt64
    var random: [Character]
  }

  private let last = Mutex<Last?>(nil)

  public init() {}

  public func next(now: Double = Date().timeIntervalSince1970 * 1000) -> String {
    let millis = UInt64(max(now.rounded(.down), 0))
    let random: [Character] = last.withLock { state in
      if let current = state, current.millis == millis,
        let bumped = ULIDGenerator.increment(current.random)
      {
        state = Last(millis: millis, random: bumped)
        return bumped
      }
      let fresh = ULIDGenerator.randomTail()
      state = Last(millis: millis, random: fresh)
      return fresh
    }
    return ULIDGenerator.encodeTime(millis) + String(random)
  }

  static func encodeTime(_ millis: UInt64) -> String {
    var characters = [Character](repeating: ulidAlphabet[0], count: ulidTimeLength)
    var value = millis
    for index in stride(from: ulidTimeLength - 1, through: 0, by: -1) {
      characters[index] = ulidAlphabet[Int(value % 32)]
      value /= 32
    }
    return String(characters)
  }

  static func randomTail() -> [Character] {
    // `byte % 32` is what the web does; keeping it means both clients draw from
    // the same (slightly biased) distribution over the same alphabet.
    (0..<ulidRandomLength).map { _ in ulidAlphabet[Int(UInt8.random(in: 0...255) % 32)] }
  }

  /// Increment the random tail as a base32 number; `nil` on all-`Z` overflow, in
  /// which case the caller draws a fresh tail.
  static func increment(_ tail: [Character]) -> [Character]? {
    var characters = tail
    var index = characters.count - 1
    while index >= 0 {
      guard let position = ulidAlphabet.firstIndex(of: characters[index]) else { return nil }
      if position < ulidAlphabet.count - 1 {
        characters[index] = ulidAlphabet[position + 1]
        return characters
      }
      characters[index] = ulidAlphabet[0]
      index -= 1
    }
    return nil
  }
}

/// Process-wide generator; every node id in the app comes from here.
public let sharedULID = ULIDGenerator()

public func ulid() -> String { sharedULID.next() }
