//
//  FocusRange.swift
//  RectoEditor
//

import Foundation
import NaturalLanguage

/// What focus dimming keeps lit: the sentence or the paragraph at the caret.
public enum FocusDimScope: String, Sendable, CaseIterable {
    case sentence
    case paragraph
}

/// `lib/editor/focus-range.ts`: the active sentence or paragraph for a caret,
/// as a UTF-16 range over the source. Paragraphs split on blank lines, and a
/// sentence is found inside its paragraph only, so it never runs across one.
/// Sentences come from `NLTokenizer` where the web uses `Intl.Segmenter`; both
/// are the platform's own sentence rules.
enum FocusRange {
    static func active(in text: NSString, caret: Int, scope: FocusDimScope) -> NSRange? {
        let length = text.length
        let clamped = min(max(caret, 0), length)
        // Runs on every caret move, so it scans outward from the caret rather
        // than splitting the whole document into paragraphs.
        guard let anchor = anchor(near: clamped, in: text) else { return nil }
        let block = paragraph(around: anchor, in: text)
        switch scope {
        case .paragraph:
            return block
        case .sentence:
            return sentence(in: text, block: block, caret: clamped)
        }
    }

    /// Lines of the text as UTF-16 ranges. `true` when the line holds only
    /// spaces and tabs, which is what makes it a paragraph break.
    private static func isBlank(_ line: NSRange, in text: NSString) -> Bool {
        for index in line.location..<NSMaxRange(line) {
            switch text.character(at: index) {
            case 0x20, 0x09, 0x0A, 0x0D: continue
            default: return false
            }
        }
        return true
    }

    /// A non-whitespace position that decides the caret's paragraph: the caret
    /// itself inside a paragraph, the next paragraph's first character when the
    /// caret sits in a gap, the last one's when it is past them all (the web's
    /// `blockAtCaret`). `nil` for whitespace-only text.
    private static func anchor(near caret: Int, in text: NSString) -> Int? {
        let whitespace = CharacterSet.whitespacesAndNewlines
        func isSpace(_ index: Int) -> Bool {
            Unicode.Scalar(text.character(at: index)).map(whitespace.contains) ?? false
        }
        // Inside a paragraph, or right after its last character.
        if caret < text.length, !isSpace(caret) { return caret }
        if caret > 0, !isSpace(caret - 1) {
            let line = text.lineRange(for: NSRange(location: caret - 1, length: 0))
            if caret <= NSMaxRange(line), !isBlank(line, in: text) { return caret - 1 }
        }
        var forward = caret
        while forward < text.length, isSpace(forward) { forward += 1 }
        if forward < text.length { return forward }
        var backward = min(caret, text.length) - 1
        while backward >= 0, isSpace(backward) { backward -= 1 }
        return backward >= 0 ? backward : nil
    }

    /// The blank-line-separated block holding `anchor`, trimmed.
    private static func paragraph(around anchor: Int, in text: NSString) -> NSRange {
        var first = text.lineRange(for: NSRange(location: anchor, length: 0))
        while first.location > 0 {
            let previous = text.lineRange(for: NSRange(location: first.location - 1, length: 0))
            if isBlank(previous, in: text) { break }
            first = previous
        }
        var last = text.lineRange(for: NSRange(location: anchor, length: 0))
        while NSMaxRange(last) < text.length {
            let next = text.lineRange(for: NSRange(location: NSMaxRange(last), length: 0))
            if isBlank(next, in: text) { break }
            last = next
        }
        return trim(NSRange(location: first.location, length: NSMaxRange(last) - first.location), in: text)
    }

    private static func trim(_ range: NSRange, in text: NSString) -> NSRange {
        let whitespace = CharacterSet.whitespacesAndNewlines
        var start = range.location
        var end = NSMaxRange(range)
        while start < end, let scalar = Unicode.Scalar(text.character(at: start)), whitespace.contains(scalar) {
            start += 1
        }
        while end > start, let scalar = Unicode.Scalar(text.character(at: end - 1)), whitespace.contains(scalar) {
            end -= 1
        }
        return NSRange(location: start, length: end - start)
    }

    private static func sentence(in text: NSString, block: NSRange, caret: Int) -> NSRange {
        let paragraph = text.substring(with: block)
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = paragraph
        let caretInBlock = min(max(caret - block.location, 0), block.length)
        var chosen: NSRange?
        var last: NSRange?
        tokenizer.enumerateTokens(in: paragraph.startIndex..<paragraph.endIndex) { tokenRange, _ in
            let sentence = NSRange(tokenRange, in: paragraph)
            last = sentence
            // The sentence the caret is at the start of: [start, end).
            if caretInBlock >= sentence.location && caretInBlock < NSMaxRange(sentence) {
                chosen = sentence
                return false
            }
            return true
        }
        guard let pick = chosen ?? last else { return block }
        return trim(NSRange(location: block.location + pick.location, length: pick.length), in: text)
    }
}
