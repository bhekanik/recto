import Foundation

/// Diff granularity the user can choose (mirrors a studio setting).
public enum DiffGranularity: String, Sendable, CaseIterable {
  case word
  case line
}

public enum DiffRunKind: String, Sendable, Equatable {
  case add
  case del
  case same
}

/// One inline run in a token diff: added / deleted / unchanged text.
public struct DiffRun: Equatable, Sendable {
  public var type: DiffRunKind
  public var text: String

  public init(type: DiffRunKind, text: String) {
    self.type = type
    self.text = text
  }
}

/// Token-level diff of two canonical-Markdown strings (blueprint 08 §5 — diff the
/// source, not rendered HTML). Port of `lib/history/diff.ts` `diffRuns`.
public func diffRuns(_ a: String, _ b: String, granularity: DiffGranularity = .word) -> [DiffRun] {
  let changes =
    granularity == .word
    ? JSDiff.diff(
      oldTokens: JSDiff.tokenizeWordsWithSpace(a), newTokens: JSDiff.tokenizeWordsWithSpace(b))
    : JSDiff.diff(oldTokens: JSDiff.tokenizeLines(a), newTokens: JSDiff.tokenizeLines(b))
  return changes.map {
    DiffRun(type: $0.added ? .add : ($0.removed ? .del : .same), text: $0.value)
  }
}

/// One reviewable hunk of a branch diff: a maximal group of consecutive non-`same`
/// runs, addressable by its stable `index`.
///
/// The grouping is deterministic from the runs, and `convex/history.ts` computes
/// the identical grouping server-side — that is what makes per-hunk accept
/// server-authoritative (the client sends hunk indices, never markdown).
public struct DiffHunk: Equatable, Sendable {
  public var index: Int
  public var runIndices: [Int]
}

public func groupHunks(_ runs: [DiffRun]) -> [DiffHunk] {
  var hunks: [DiffHunk] = []
  var current: [Int]?
  for (index, run) in runs.enumerated() {
    if run.type == .same {
      if let pending = current {
        hunks.append(DiffHunk(index: hunks.count, runIndices: pending))
        current = nil
      }
      continue
    }
    current = (current ?? []) + [index]
  }
  if let pending = current {
    hunks.append(DiffHunk(index: hunks.count, runIndices: pending))
  }
  return hunks
}

/// Reconstruct the partial-merge Markdown when only `acceptedHunks` of the
/// `current → branch` diff are accepted. Mirrored byte-for-byte by
/// `convex/history.ts` so the preview matches what the server writes.
public func applyAcceptedHunks(_ runs: [DiffRun], _ acceptedHunks: some Sequence<Int>) -> String {
  let accepted = Set(acceptedHunks)
  var acceptedRunIndices: Set<Int> = []
  for hunk in groupHunks(runs) where accepted.contains(hunk.index) {
    acceptedRunIndices.formUnion(hunk.runIndices)
  }

  var out = ""
  for (index, run) in runs.enumerated() {
    if run.type == .same {
      out += run.text
    } else if acceptedRunIndices.contains(index) {
      // Accepted hunk → take the branch (add) side; accepted deletions vanish.
      if run.type == .add { out += run.text }
    } else if run.type == .del {
      // Rejected hunk → keep the current text and discard the addition.
      out += run.text
    }
  }
  return out
}

public struct DiffLine: Equatable, Sendable {
  public var type: DiffRunKind
  public var text: String
}

/// A minimal LCS line diff, used by the compare view. Port of `diffLines` in
/// `lib/history/diff.ts` — not jsdiff; the two produce different groupings and
/// the UI depends on this one's shape.
public func diffLines(_ a: String, _ b: String) -> [DiffLine] {
  let aLines = a.components(separatedBy: "\n")
  let bLines = b.components(separatedBy: "\n")
  let m = aLines.count
  let n = bLines.count

  // dp[i][j] = LCS length of aLines[i...] and bLines[j...].
  var dp = [[Int]](repeating: [Int](repeating: 0, count: n + 1), count: m + 1)
  for i in stride(from: m - 1, through: 0, by: -1) {
    for j in stride(from: n - 1, through: 0, by: -1) {
      dp[i][j] =
        aLines[i].utf8.elementsEqual(bLines[j].utf8)
        ? dp[i + 1][j + 1] + 1
        : max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  var out: [DiffLine] = []
  var i = 0
  var j = 0
  while i < m, j < n {
    if aLines[i].utf8.elementsEqual(bLines[j].utf8) {
      out.append(DiffLine(type: .same, text: aLines[i]))
      i += 1
      j += 1
    } else if dp[i + 1][j] >= dp[i][j + 1] {
      out.append(DiffLine(type: .del, text: aLines[i]))
      i += 1
    } else {
      out.append(DiffLine(type: .add, text: bLines[j]))
      j += 1
    }
  }
  while i < m {
    out.append(DiffLine(type: .del, text: aLines[i]))
    i += 1
  }
  while j < n {
    out.append(DiffLine(type: .add, text: bLines[j]))
    j += 1
  }
  return out
}

private let labelQuoteUnits = 32

/// The inserted text as a one-line quote for a history label, or "" when there is
/// nothing readable to quote: only whitespace, or a lone surrogate (a patch
/// boundary inside an emoji). Works on UTF-16 units and four literal whitespace characters
/// so the result is identical to `labelQuote` in `lib/history/diff.ts`.
private func labelQuote(_ insert: JSString) -> String {
  guard insert.isWellFormed else { return "" }
  let whitespace: Set<UInt16> = [0x20, 0x09, 0x0A, 0x0D]
  var line: [UInt16] = []
  for unit in insert.units {
    if whitespace.contains(unit) {
      if line.last != 0x20 { line.append(0x20) }
    } else {
      line.append(unit)
    }
  }
  if line.first == 0x20 { line.removeFirst() }
  if line.last == 0x20 { line.removeLast() }
  if line.count <= labelQuoteUnits { return JSString(units: line).lossyString }
  var cut = Array(line.prefix(labelQuoteUnits))
  if let last = cut.last, (0xD800...0xDBFF).contains(last) { cut.removeLast() }
  return JSString(units: cut).lossyString + "…"
}

/// A short human label for an undo node, derived from its patch (blueprint 07 §4 B4).
public func nodeLabel(patch: String, parentNodeId: String?, origin: String? = nil) -> String {
  if parentNodeId == nil { return "Document created" }
  if origin == "restore" { return "Restored a version" }
  // AI transforms tag their node `ai:<instruction label>` (plan 009).
  if let origin, origin.hasPrefix("ai:") {
    let label = origin.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty ? "AI edit" : "AI: \(label)"
  }
  if origin == "ai" { return "AI edit" }
  guard let decoded = try? TextPatch.decode(patch) else { return "Change" }
  let removed = decoded.to - decoded.from
  let added = decoded.insert.count
  // The words say more than a count. A deletion's text is not in its patch.
  let quote = labelQuote(decoded.insert)
  if !quote.isEmpty {
    return removed == 0 ? "Added “\(quote)”" : "Changed to “\(quote)”"
  }
  if added > 0, removed == 0 { return "Added \(added) char\(added == 1 ? "" : "s")" }
  if removed > 0, added == 0 { return "Removed \(removed) char\(removed == 1 ? "" : "s")" }
  if added > 0 || removed > 0 { return "Edited" }
  return "Change"
}
