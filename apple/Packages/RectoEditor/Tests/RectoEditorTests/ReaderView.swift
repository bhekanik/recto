//
//  ReaderView.swift
//  RectoEditorTests
//
//  Turns a styled document into text a human can review: which characters the
//  reader sees, which the styler hid, and what the visible ones are set in.
//  The snapshot files under `Snapshots/` are this output, checked in, so a
//  change to the rendering rules shows up as a readable diff instead of an
//  attribute-dictionary dump nobody reads.
//

import AppKit
import Foundation
@testable import RectoEditor

enum ReaderView {
    /// `·` stands in for a character the styler hid, `⏎` for a newline, `→`
    /// for a tab. Everything else is what the reader sees.
    static let hiddenMark: Character = "·"

    /// One line per document line: the reader's view, then the runs behind it.
    ///
    /// A frontmatter block the styler has hidden collapses to a single
    /// annotation naming its fields. Without it the dump would show a run of
    /// `·` indistinguishable from lost text, and the point of hiding
    /// frontmatter is that its content moves to the document header rather
    /// than disappearing.
    static func dump(_ styled: NSAttributedString, frontmatter: Frontmatter? = nil) -> String {
        let ns = styled.string as NSString
        var out: [String] = []
        var cursor = 0
        while cursor < ns.length {
            let line = ns.lineRange(for: NSRange(location: cursor, length: 0))
            if let frontmatter, line.location == frontmatter.range.location,
               isEntirelyHidden(styled, range: frontmatter.range) {
                out.append(annotation(for: frontmatter))
                cursor = NSMaxRange(frontmatter.range)
                continue
            }
            out.append(render(styled, line: line))
            guard NSMaxRange(line) > cursor else { break }
            cursor = NSMaxRange(line)
        }
        if ns.length == 0 { out.append("") }
        return out.joined(separator: "\n")
    }

    /// What the header view will read, spelled out where the block used to be.
    private static func annotation(for frontmatter: Frontmatter) -> String {
        let fields = frontmatter.fields
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: " · ")
        return "[frontmatter hidden, \(frontmatter.range.length) chars: \(fields)]    —"
    }

    private static func isEntirelyHidden(_ styled: NSAttributedString, range: NSRange) -> Bool {
        let ns = styled.string as NSString
        guard NSMaxRange(range) <= ns.length else { return false }
        for index in range.location..<NSMaxRange(range)
        where !isHidden(styled, at: index) && !CharacterSet.newlines.contains(
            UnicodeScalar(ns.character(at: index)) ?? " ") {
            return false
        }
        return true
    }

    private static func render(_ styled: NSAttributedString, line: NSRange) -> String {
        let ns = styled.string as NSString
        var visible = ""
        for index in line.location..<NSMaxRange(line) {
            let character = Character(UnicodeScalar(ns.character(at: index)) ?? " ")
            if isHidden(styled, at: index) {
                visible.append(hiddenMark)
            } else if character == "\n" {
                visible.append("⏎")
            } else if character == "\r" {
                visible.append("⏎")
            } else if character == "\t" {
                visible.append("→")
            } else {
                visible.append(character)
            }
        }
        return "\(visible)    \(styleSummary(styled, line: line))"
    }

    /// The styler hides a marker by shrinking it to a tiny font and kerning it
    /// to nothing, or by painting it clear — never by removing it from the
    /// string. Either signal means the reader does not see the character.
    static func isHidden(_ styled: NSAttributedString, at index: Int) -> Bool {
        let attributes = styled.attributes(at: index, effectiveRange: nil)
        if let font = attributes[.font] as? NSFont, font.pointSize < 1 { return true }
        if let color = attributes[.foregroundColor] as? NSColor,
           color.usingColorSpace(.sRGB)?.alphaComponent ?? 1 < 0.01 { return true }
        return false
    }

    /// A compact description of the visible runs on a line: size, weight, and
    /// the notable attributes. Enough to see "this line is a 32 pt bold
    /// heading" without printing a dictionary.
    private static func styleSummary(_ styled: NSAttributedString, line: NSRange) -> String {
        var parts: [String] = []
        var index = line.location
        while index < NSMaxRange(line) {
            var effective = NSRange(location: 0, length: 0)
            let attributes = styled.attributes(at: index, longestEffectiveRange: &effective,
                                               in: line)
            let next = max(NSMaxRange(effective), index + 1)
            defer { index = next }
            guard !isHidden(styled, at: index) else { continue }
            let text = (styled.string as NSString).substring(with: effective)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            var descriptors: [String] = []
            if let font = attributes[.font] as? NSFont {
                descriptors.append(String(format: "%.1f", font.pointSize))
                let traits = font.fontDescriptor.symbolicTraits
                if traits.contains(.bold) { descriptors.append("bold") }
                if traits.contains(.italic) { descriptors.append("italic") }
                if traits.contains(.monoSpace) { descriptors.append("mono") }
            }
            if let paragraph = attributes[.paragraphStyle] as? NSParagraphStyle,
               paragraph.headIndent > 0 {
                // List nesting is otherwise invisible here, and getting the
                // level right is one of the dialect fixes.
                descriptors.append("indent \(Int(paragraph.headIndent.rounded()))")
            }
            if attributes[.link] != nil { descriptors.append("link") }
            if attributes[.strikethroughStyle] != nil { descriptors.append("strike") }
            if attributes[.backgroundColor] != nil { descriptors.append("fill") }
            if let last = parts.last, last == descriptors.joined(separator: " ") { continue }
            parts.append(descriptors.joined(separator: " "))
        }
        return parts.isEmpty ? "—" : parts.joined(separator: " | ")
    }
}
