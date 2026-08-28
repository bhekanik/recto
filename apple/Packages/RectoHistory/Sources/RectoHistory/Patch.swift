import Foundation

/// Compact text patch: a single contiguous replace relative to the parent's
/// materialized Markdown, in UTF-16 offsets (`lib/history/patch.ts`).
public struct TextPatch: Equatable, Sendable {
  public var from: Int
  public var to: Int
  public var insert: JSString

  public init(from: Int, to: Int, insert: JSString) {
    self.from = from
    self.to = to
    self.insert = insert
  }

  public init(from: Int, to: Int, insert: String) {
    self.init(from: from, to: to, insert: JSString(insert))
  }
}

/// A full Markdown snapshot is stored on the root node and every Nth node along
/// a branch, bounding materialization replay length (blueprint 03 §4.2).
public let snapshotEveryN = 50

extension TextPatch {
  /// Byte-identical to `JSON.stringify({from, to, insert})`: same key order, same
  /// escaping. The web and the server both re-read this string.
  public var encoded: String {
    "{\"from\":\(from),\"to\":\(to),\"insert\":\(insert.jsonEncoded)}"
  }

  public static func decode(_ raw: String) throws -> TextPatch {
    try PatchJSON.decode(raw)
  }
}

/// Apply a patch to a parent's materialized Markdown.
public func applyPatch(_ parent: JSString, _ patch: TextPatch) -> JSString {
  parent.slice(0, patch.from) + patch.insert + parent.slice(patch.to, parent.count)
}

/// Apply a stored `docNodes.patch` payload to a parent's materialized Markdown.
public func applyPatch(_ parent: String, patchRaw: String) throws -> String {
  let result = applyPatch(JSString(parent), try TextPatch.decode(patchRaw))
  guard let string = result.string else { throw PatchDecodingError.illFormedResult }
  return string
}

/// Minimal contiguous patch of `next` relative to `parent` (longest common
/// prefix/suffix trim), comparing UTF-16 code units exactly as `charCodeAt` does.
///
/// Contract: `applyPatch(parent, computePatch(parent, next)) == next`.
public func computePatch(_ parent: JSString, _ next: JSString) -> TextPatch {
  var start = 0
  let max = min(parent.count, next.count)
  while start < max, parent.units[start] == next.units[start] {
    start += 1
  }
  var endPrev = parent.count
  var endNext = next.count
  while endPrev > start, endNext > start, parent.units[endPrev - 1] == next.units[endNext - 1] {
    endPrev -= 1
    endNext -= 1
  }
  return TextPatch(from: start, to: endPrev, insert: next.slice(start, endNext))
}

public func computePatch(_ parent: String, _ next: String) -> TextPatch {
  computePatch(JSString(parent), JSString(next))
}
