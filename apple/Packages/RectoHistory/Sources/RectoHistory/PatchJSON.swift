import Foundation

/// Errors from decoding a stored `docNodes.patch` payload.
public enum PatchDecodingError: Error, Equatable, Sendable {
  case malformedJSON(String)
  case missingField(String)
  case illFormedResult
}

/// A JSON reader for the `{from, to, insert}` patch envelope.
///
/// `JSONSerialization` is not usable here: the web can store a patch whose
/// `insert` is a lone surrogate (`"\ud83d"`), which Foundation either rejects or
/// silently rewrites to U+FFFD — both of which corrupt the document. This reader
/// keeps strings as raw UTF-16 code units all the way through.
enum PatchJSON {
  static func decode(_ raw: String) throws -> TextPatch {
    var scanner = Scanner(units: Array(raw.utf16))
    let fields = try scanner.parseObject()
    try scanner.skipWhitespace()
    guard scanner.isAtEnd else { throw PatchDecodingError.malformedJSON("trailing content") }

    guard case .number(let from)? = fields["from"] else {
      throw PatchDecodingError.missingField("from")
    }
    guard case .number(let to)? = fields["to"] else {
      throw PatchDecodingError.missingField("to")
    }
    guard case .string(let insert)? = fields["insert"] else {
      throw PatchDecodingError.missingField("insert")
    }
    return TextPatch(from: Int(from), to: Int(to), insert: insert)
  }

  enum Value {
    case number(Double)
    case string(JSString)
    case other
  }

  /// Only the subset of JSON a patch envelope can contain.
  struct Scanner {
    let units: [UInt16]
    var index = 0

    var isAtEnd: Bool { index >= units.count }

    mutating func skipWhitespace() throws {
      while index < units.count {
        switch units[index] {
        case 0x20, 0x09, 0x0A, 0x0D: index += 1
        default: return
        }
      }
    }

    mutating func parseObject() throws -> [String: Value] {
      try skipWhitespace()
      try expect(0x7B, "{")
      var out: [String: Value] = [:]
      try skipWhitespace()
      if peek() == 0x7D {
        index += 1
        return out
      }
      while true {
        try skipWhitespace()
        let key = try parseString()
        try skipWhitespace()
        try expect(0x3A, ":")
        let value = try parseValue()
        out[key.lossyString] = value
        try skipWhitespace()
        switch peek() {
        case 0x2C: index += 1
        case 0x7D:
          index += 1
          return out
        default: throw PatchDecodingError.malformedJSON("expected , or } in object")
        }
      }
    }

    mutating func parseValue() throws -> Value {
      try skipWhitespace()
      switch peek() {
      case 0x22: return .string(try parseString())
      case 0x7B:
        _ = try parseObject()
        return .other
      case UInt16(UInt8(ascii: "n")), UInt16(UInt8(ascii: "t")), UInt16(UInt8(ascii: "f")):
        while let unit = peek(), unit >= 0x61, unit <= 0x7A { index += 1 }
        return .other
      default: return .number(try parseNumber())
      }
    }

    mutating func parseNumber() throws -> Double {
      let start = index
      while let unit = peek() {
        // digits, sign, decimal point, exponent
        if (unit >= 0x30 && unit <= 0x39) || unit == 0x2D || unit == 0x2B || unit == 0x2E
          || unit == 0x65 || unit == 0x45
        {
          index += 1
        } else {
          break
        }
      }
      let text = String(decoding: units[start..<index], as: UTF16.self)
      guard let value = Double(text) else {
        throw PatchDecodingError.malformedJSON("bad number \(text)")
      }
      return value
    }

    mutating func parseString() throws -> JSString {
      try expect(0x22, "\"")
      var out: [UInt16] = []
      while true {
        guard let unit = peek() else { throw PatchDecodingError.malformedJSON("unterminated string") }
        index += 1
        if unit == 0x22 { return JSString(units: out) }
        guard unit == 0x5C else {
          out.append(unit)
          continue
        }
        guard let escape = peek() else {
          throw PatchDecodingError.malformedJSON("unterminated escape")
        }
        index += 1
        switch escape {
        case 0x22: out.append(0x22)
        case 0x5C: out.append(0x5C)
        case 0x2F: out.append(0x2F)
        case UInt16(UInt8(ascii: "b")): out.append(0x08)
        case UInt16(UInt8(ascii: "f")): out.append(0x0C)
        case UInt16(UInt8(ascii: "n")): out.append(0x0A)
        case UInt16(UInt8(ascii: "r")): out.append(0x0D)
        case UInt16(UInt8(ascii: "t")): out.append(0x09)
        case UInt16(UInt8(ascii: "u")):
          guard index + 4 <= units.count else {
            throw PatchDecodingError.malformedJSON("truncated \\u escape")
          }
          var value: UInt16 = 0
          for offset in 0..<4 {
            guard let digit = Self.hexValue(units[index + offset]) else {
              throw PatchDecodingError.malformedJSON("bad \\u escape")
            }
            value = value << 4 | UInt16(digit)
          }
          index += 4
          out.append(value)
        default:
          throw PatchDecodingError.malformedJSON("unknown escape")
        }
      }
    }

    func peek() -> UInt16? { index < units.count ? units[index] : nil }

    mutating func expect(_ unit: UInt16, _ label: String) throws {
      guard peek() == unit else { throw PatchDecodingError.malformedJSON("expected \(label)") }
      index += 1
    }

    static func hexValue(_ unit: UInt16) -> Int? {
      switch unit {
      case 0x30...0x39: return Int(unit - 0x30)
      case 0x41...0x46: return Int(unit - 0x41) + 10
      case 0x61...0x66: return Int(unit - 0x61) + 10
      default: return nil
      }
    }
  }
}
