import Foundation

/// A port of the `diff` (jsdiff) 9.0.0 core the web uses for version compare
/// (`lib/history/diff.ts`) and — byte-identically — the server uses to
/// reconstruct partial merges (`convex/history.ts`).
///
/// Only the two configurations Recto calls exist here: `diffWordsWithSpace` and
/// `diffLines`, both with no options. Neither overrides `equals`, `join` or
/// `postProcess` in that configuration, so one Myers implementation serves both
/// and the port stays small enough to audit against the JS.
enum JSDiff {
  struct Change: Equatable, Sendable {
    var count: Int
    var added: Bool
    var removed: Bool
    var value: String
  }

  // MARK: - Myers core (jsdiff `Diff.prototype.diff`)

  static func diff(oldTokens rawOld: [String], newTokens rawNew: [String]) -> [Change] {
    let oldTokens = rawOld.filter { !$0.isEmpty }
    let newTokens = rawNew.filter { !$0.isEmpty }
    let oldLen = oldTokens.count
    let newLen = newTokens.count

    var bestPath: [Int: Path] = [0: Path(oldPos: -1, lastComponent: nil)]
    var newPos = extractCommon(bestPath[0]!, newTokens, oldTokens, 0)
    if bestPath[0]!.oldPos + 1 >= oldLen, newPos + 1 >= newLen {
      return buildValues(bestPath[0]!.lastComponent, newTokens, oldTokens)
    }

    // Once a diagonal reaches the right or bottom edge of the edit graph there
    // is no point exploring past it (jsdiff's deviation from the paper; it is
    // what makes a pure append O(n+d) instead of O(n+d²)).
    var minDiagonal = Int.min
    var maxDiagonal = Int.max
    var editLength = 1
    let maxEditLength = newLen + oldLen

    while editLength <= maxEditLength {
      var diagonal = max(minDiagonal, -editLength)
      let upper = min(maxDiagonal, editLength)
      while diagonal <= upper {
        let removePath = bestPath[diagonal - 1]
        let addPath = bestPath[diagonal + 1]
        if removePath != nil { bestPath[diagonal - 1] = nil }

        var canAdd = false
        if let addPath {
          let addPathNewPos = addPath.oldPos - diagonal
          canAdd = addPathNewPos >= 0 && addPathNewPos < newLen
        }
        let canRemove = removePath.map { $0.oldPos + 1 < oldLen } ?? false

        if !canAdd && !canRemove {
          bestPath[diagonal] = nil
          diagonal += 2
          continue
        }

        let basePath: Path
        if !canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos) {
          basePath = addToPath(addPath!, added: true, removed: false, oldPosInc: 0)
        } else {
          basePath = addToPath(removePath!, added: false, removed: true, oldPosInc: 1)
        }

        newPos = extractCommon(basePath, newTokens, oldTokens, diagonal)
        if basePath.oldPos + 1 >= oldLen, newPos + 1 >= newLen {
          return buildValues(basePath.lastComponent, newTokens, oldTokens)
        }
        bestPath[diagonal] = basePath
        if basePath.oldPos + 1 >= oldLen {
          maxDiagonal = min(maxDiagonal, diagonal - 1)
        }
        if newPos + 1 >= newLen {
          minDiagonal = max(minDiagonal, diagonal + 1)
        }
        diagonal += 2
      }
      editLength += 1
    }
    return []
  }

  private final class Component {
    var count: Int
    let added: Bool
    let removed: Bool
    let previous: Component?

    init(count: Int, added: Bool, removed: Bool, previous: Component?) {
      self.count = count
      self.added = added
      self.removed = removed
      self.previous = previous
    }
  }

  private final class Path {
    var oldPos: Int
    var lastComponent: Component?

    init(oldPos: Int, lastComponent: Component?) {
      self.oldPos = oldPos
      self.lastComponent = lastComponent
    }
  }

  private static func addToPath(_ path: Path, added: Bool, removed: Bool, oldPosInc: Int) -> Path {
    if let last = path.lastComponent, last.added == added, last.removed == removed {
      return Path(
        oldPos: path.oldPos + oldPosInc,
        lastComponent: Component(
          count: last.count + 1, added: added, removed: removed, previous: last.previous))
    }
    return Path(
      oldPos: path.oldPos + oldPosInc,
      lastComponent: Component(
        count: 1, added: added, removed: removed, previous: path.lastComponent))
  }

  private static func extractCommon(
    _ basePath: Path, _ newTokens: [String], _ oldTokens: [String], _ diagonal: Int
  ) -> Int {
    var oldPos = basePath.oldPos
    var newPos = oldPos - diagonal
    var commonCount = 0
    while newPos + 1 < newTokens.count, oldPos + 1 < oldTokens.count,
      // JS `===` compares code units. Swift's `==` compares canonical
      // equivalence, so "é" and "e\u{301}" would wrongly diff as equal.
      oldTokens[oldPos + 1].utf8.elementsEqual(newTokens[newPos + 1].utf8)
    {
      newPos += 1
      oldPos += 1
      commonCount += 1
    }
    if commonCount > 0 {
      basePath.lastComponent = Component(
        count: commonCount, added: false, removed: false, previous: basePath.lastComponent)
    }
    basePath.oldPos = oldPos
    return newPos
  }

  private static func buildValues(
    _ lastComponent: Component?, _ newTokens: [String], _ oldTokens: [String]
  ) -> [Change] {
    var components: [Component] = []
    var cursor = lastComponent
    while let component = cursor {
      components.append(component)
      cursor = component.previous
    }
    components.reverse()

    var out: [Change] = []
    var newPos = 0
    var oldPos = 0
    for component in components {
      if component.removed {
        out.append(
          Change(
            count: component.count, added: false, removed: true,
            value: oldTokens[oldPos..<(oldPos + component.count)].joined()))
        oldPos += component.count
      } else {
        out.append(
          Change(
            count: component.count, added: component.added, removed: false,
            value: newTokens[newPos..<(newPos + component.count)].joined()))
        newPos += component.count
        if !component.added { oldPos += component.count }
      }
    }
    return out
  }

  // MARK: - Tokenizers

  /// `WordsWithSpaceDiff.tokenize`:
  /// `/(\r?\n)|[wordChars]+|[^\S\n\r]+|[^wordChars]/ug`.
  static func tokenizeWordsWithSpace(_ value: String) -> [String] {
    var tokens: [String] = []
    let scalars = Array(value.unicodeScalars)
    var index = 0
    while index < scalars.count {
      let scalar = scalars[index]
      if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" {
        tokens.append("\r\n")
        index += 2
      } else if scalar == "\n" {
        tokens.append("\n")
        index += 1
      } else if isWordScalar(scalar) {
        let start = index
        while index < scalars.count, isWordScalar(scalars[index]) { index += 1 }
        tokens.append(String(String.UnicodeScalarView(scalars[start..<index])))
      } else if isJSWhitespace(scalar), scalar != "\n", scalar != "\r" {
        let start = index
        while index < scalars.count, isJSWhitespace(scalars[index]), scalars[index] != "\n",
          scalars[index] != "\r"
        {
          index += 1
        }
        tokens.append(String(String.UnicodeScalarView(scalars[start..<index])))
      } else {
        tokens.append(String(scalar))
        index += 1
      }
    }
    return tokens
  }

  /// `lineDiff.tokenize`: `value.split(/(\n|\r\n)/)` with the separators merged
  /// back onto the preceding line and the trailing empty token dropped.
  static func tokenizeLines(_ value: String) -> [String] {
    guard !value.isEmpty else { return [] }
    var lines: [String] = []
    var current = ""
    let scalars = Array(value.unicodeScalars)
    var index = 0
    while index < scalars.count {
      let scalar = scalars[index]
      if scalar == "\n" {
        current.unicodeScalars.append(scalar)
        lines.append(current)
        current = ""
        index += 1
      } else if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" {
        current.unicodeScalars.append(scalar)
        current.unicodeScalars.append(scalars[index + 1])
        lines.append(current)
        current = ""
        index += 2
      } else {
        current.unicodeScalars.append(scalar)
        index += 1
      }
    }
    if !current.isEmpty { lines.append(current) }
    return lines
  }

  /// The `extendedWordChars` class from jsdiff's word diff.
  static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x30...0x39, 0x41...0x5A, 0x5F, 0x61...0x7A: return true
    case 0xAD: return true
    case 0xC0...0xD6, 0xD8...0xF6, 0xF8...0x2C6, 0x2C8...0x2D7, 0x2DE...0x2FF: return true
    case 0x1E00...0x1EFF: return true
    default: return false
    }
  }

  /// ECMAScript `\s`: Unicode space separators plus the ASCII controls, U+00A0,
  /// U+1680, U+2028/9, U+FEFF. `Character.isWhitespace` disagrees on U+FEFF and
  /// U+180E, so the set is spelled out.
  static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20: return true
    case 0xA0, 0x1680: return true
    case 0x2000...0x200A: return true
    case 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
  }
}
