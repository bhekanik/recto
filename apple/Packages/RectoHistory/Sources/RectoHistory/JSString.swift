import Foundation

/// A JavaScript string: a sequence of UTF-16 code units that is *not* required
/// to be well-formed Unicode.
///
/// The web client computes patches with `charCodeAt` / `slice`, so a patch
/// boundary can land between the two halves of a surrogate pair and the stored
/// `insert` can be a lone surrogate — a value `Swift.String` cannot represent.
/// Doing the arithmetic on `[UInt16]` is the only way a Swift port stays
/// byte-identical to `lib/history/patch.ts` for emoji edits.
public struct JSString: Equatable, Hashable, Sendable {
  public private(set) var units: [UInt16]

  public init(units: [UInt16]) { self.units = units }
  public init(_ string: String) { self.units = Array(string.utf16) }
  public init() { self.units = [] }

  public var count: Int { units.count }
  public var isEmpty: Bool { units.isEmpty }

  /// True when every surrogate is correctly paired, i.e. the units round-trip
  /// through `Swift.String` unchanged.
  public var isWellFormed: Bool {
    var index = 0
    while index < units.count {
      let unit = units[index]
      if unit >= 0xD800, unit <= 0xDBFF {
        guard index + 1 < units.count, units[index + 1] >= 0xDC00, units[index + 1] <= 0xDFFF
        else { return false }
        index += 2
      } else if unit >= 0xDC00, unit <= 0xDFFF {
        return false
      } else {
        index += 1
      }
    }
    return true
  }

  /// `nil` when the units contain an unpaired surrogate.
  public var string: String? {
    guard isWellFormed else { return nil }
    return String(decoding: units, as: UTF16.self)
  }

  /// Unpaired surrogates become U+FFFD. Only for display and error messages.
  public var lossyString: String { String(decoding: units, as: UTF16.self) }

  /// `String.prototype.slice` semantics: clamped, empty when `start >= end`.
  public func slice(_ start: Int, _ end: Int) -> JSString {
    let lower = min(max(start, 0), units.count)
    let upper = min(max(end, 0), units.count)
    guard lower < upper else { return JSString() }
    return JSString(units: Array(units[lower..<upper]))
  }

  public static func + (lhs: JSString, rhs: JSString) -> JSString {
    JSString(units: lhs.units + rhs.units)
  }

  // MARK: - JSON

  /// `JSON.stringify` of a string value, including the ES2019 well-formed
  /// escaping of unpaired surrogates that keeps the output valid JSON.
  public var jsonEncoded: String {
    var out = "\""
    var index = 0
    while index < units.count {
      let unit = units[index]
      switch unit {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x08: out += "\\b"
      case 0x0C: out += "\\f"
      case 0x0A: out += "\\n"
      case 0x0D: out += "\\r"
      case 0x09: out += "\\t"
      case 0..<0x20:
        out += Self.unicodeEscape(unit)
      case 0xD800...0xDBFF:
        if index + 1 < units.count, units[index + 1] >= 0xDC00, units[index + 1] <= 0xDFFF {
          out.unicodeScalars.append(
            Unicode.Scalar(
              UInt32(unit - 0xD800) &* 0x400 &+ UInt32(units[index + 1] - 0xDC00) &+ 0x10000)!)
          index += 1
        } else {
          out += Self.unicodeEscape(unit)
        }
      case 0xDC00...0xDFFF:
        out += Self.unicodeEscape(unit)
      default:
        out.unicodeScalars.append(Unicode.Scalar(unit)!)
      }
      index += 1
    }
    return out + "\""
  }

  /// `\uXXXX`, lower-case, zero-padded — what `JSON.stringify` emits.
  private static func unicodeEscape(_ unit: UInt16) -> String {
    let hex = String(unit, radix: 16, uppercase: false)
    return "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
  }
}

extension JSString: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) { self.init(value) }
}

extension JSString: CustomStringConvertible {
  public var description: String { lossyString }
}
