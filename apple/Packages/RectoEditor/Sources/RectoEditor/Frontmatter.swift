//
//  Frontmatter.swift
//  RectoEditor
//

import Foundation

/// The leading `---` … `---` block, read as data for the document header.
///
/// In rich and preview the header view draws the title, subtitle and
/// newsletter fields; the YAML itself is suppressed from the body (the engine
/// does the suppressing — see `RectoEditor/README.md`). In raw the block is
/// just text, like everything else.
///
/// This reads the top-level scalar keys and nothing more. Full YAML is the
/// canonical parser's job (`lib/markdown` on the web, RectoCoreJS natively);
/// the header needs five strings and the block's range, and inventing a second
/// YAML implementation here would be a second thing to keep in agreement.
public struct Frontmatter: Sendable, Equatable {
    /// UTF-16 range of the whole block, opening `---` through the closing
    /// `---` and its newline. This is what the body suppresses.
    public let range: NSRange
    /// Top-level `key: value` pairs, in document order. Keys whose value is a
    /// nested mapping or a sequence are present with an empty value — the
    /// header does not render them, but their presence is visible to callers.
    public let fields: [(key: String, value: String)]

    public var title: String? { self["title"] }
    public var subtitle: String? { self["subtitle"] }
    /// Newsletter subject line.
    public var subject: String? { self["subject"] }
    /// Newsletter inbox preview text.
    public var preview: String? { self["preview"] }

    public subscript(key: String) -> String? {
        fields.first { $0.key == key }.map(\.value).flatMap { $0.isEmpty ? nil : $0 }
    }

    public static func == (lhs: Frontmatter, rhs: Frontmatter) -> Bool {
        lhs.range == rhs.range
            && lhs.fields.count == rhs.fields.count
            && zip(lhs.fields, rhs.fields).allSatisfy { $0.key == $1.key && $0.value == $1.value }
    }

    /// Parse the leading frontmatter block, or `nil` when the document does not
    /// open with one.
    ///
    /// A block must start at offset 0 with a line that is exactly `---`, and
    /// end at the next line that is exactly `---` or `...`. An unterminated
    /// opener is not frontmatter — it is a thematic break followed by text,
    /// which is what a reader typing `---` at the top of an empty document has.
    public static func parse(_ markdown: String) -> Frontmatter? {
        let ns = markdown as NSString
        guard ns.length >= 4 else { return nil }
        let firstLine = ns.lineRange(for: NSRange(location: 0, length: 0))
        guard trimmed(ns, firstLine) == "---" else { return nil }

        var cursor = NSMaxRange(firstLine)
        var fields: [(key: String, value: String)] = []
        while cursor < ns.length {
            let line = ns.lineRange(for: NSRange(location: cursor, length: 0))
            let text = trimmed(ns, line)
            if text == "---" || text == "..." {
                return Frontmatter(range: NSRange(location: 0, length: NSMaxRange(line)),
                                   fields: fields)
            }
            // Indented lines belong to the value above (a sequence or a nested
            // mapping); the header shows neither, so they are skipped rather
            // than mis-read as top-level keys.
            let raw = ns.substring(with: line)
            if !raw.hasPrefix(" "), !raw.hasPrefix("\t"), !text.isEmpty, !text.hasPrefix("#"),
               let colon = text.firstIndex(of: ":") {
                let key = String(text[text.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
                let value = String(text[text.index(after: colon)...])
                    .trimmingCharacters(in: .whitespaces)
                if !key.isEmpty { fields.append((key, unquoted(value))) }
            }
            let next = NSMaxRange(line)
            guard next > cursor else { break }
            cursor = next
        }
        return nil
    }

    private static func trimmed(_ ns: NSString, _ range: NSRange) -> String {
        ns.substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func unquoted(_ value: String) -> String {
        guard value.count >= 2 else { return value }
        let first = value.first, last = value.last
        if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
            return String(value.dropFirst().dropLast())
        }
        return value
    }
}
