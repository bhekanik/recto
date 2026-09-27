//
//  FocusRangeTests.swift
//  RectoEditorTests
//
//  The cases of `lib/editor/focus-range.test.ts`, so both apps dim the same
//  span for the same caret.
//

import Foundation
import Testing
@testable import RectoEditor

@Suite("Focus range")
struct FocusRangeTests {
    private func range(_ text: String, _ caret: Int, _ scope: FocusDimScope) -> NSRange? {
        FocusRange.active(in: text as NSString, caret: caret, scope: scope)
    }

    private func slice(_ text: String, _ range: NSRange?) -> String? {
        range.map { (text as NSString).substring(with: $0) }
    }

    @Test("nothing to dim around in empty or whitespace-only text")
    func empty() {
        #expect(range("", 0, .sentence) == nil)
        #expect(range("   \n\n  ", 3, .sentence) == nil)
        #expect(range("", 0, .paragraph) == nil)
    }

    @Test("a space just typed at the end of a paragraph keeps it lit")
    func trailingSpace() {
        let text = "One two.\nth other al \n\n## heading\nis the place"
        let caret = (text as NSString).range(of: "al ").location + 3
        #expect(slice(text, range(text, caret, .paragraph)) == "One two.\nth other al")
        #expect(slice(text, range(text, caret, .sentence))?.hasSuffix("al") == true)
        #expect(range("Last words ", 11, .paragraph) == NSRange(location: 0, length: 10))
        #expect(slice("First line \nsecond\n\nNext", range("First line \nsecond\n\nNext", 11, .paragraph))
            == "First line \nsecond")
    }

    @Test("a caret on a blank line still belongs to the paragraph below")
    func blankLineGap() {
        #expect(slice("Para one.\n\nPara two.", range("Para one.\n\nPara two.", 10, .paragraph)) == "Para two.")
    }

    @Test("a single sentence is the whole range in both scopes")
    func singleSentence() {
        let text = "Hello world."
        #expect(range(text, 5, .sentence) == NSRange(location: 0, length: 12))
        #expect(range(text, 5, .paragraph) == NSRange(location: 0, length: 12))
    }

    @Test("sentence scope picks the sentence with the caret, trailing space trimmed")
    func sentence() {
        let text = "Hello world. How are you? I am fine."
        #expect(range(text, 15, .sentence) == NSRange(location: 13, length: 12))
        #expect(slice(text, range(text, 15, .sentence)) == "How are you?")
        #expect(range(text, 15, .paragraph) == NSRange(location: 0, length: (text as NSString).length))
    }

    @Test("paragraphs split on blank lines; a sentence never crosses one")
    func paragraphs() {
        let text = "Para one.\n\nPara two here."
        let second = 11
        #expect(range(text, second + 2, .paragraph) == NSRange(location: second, length: 14))
        #expect(slice(text, range(text, second + 2, .sentence)) == "Para two here.")
        #expect(range(text, 2, .paragraph) == NSRange(location: 0, length: 9))
    }

    @Test("a caret outside the text is clamped")
    func clamps() {
        let text = "Only sentence here."
        #expect(range(text, 9_999, .sentence) == NSRange(location: 0, length: 19))
        #expect(range(text, -50, .sentence) == NSRange(location: 0, length: 19))
    }

    @Test("abbreviations give a valid non-empty range")
    func abbreviations() throws {
        let text = "See Dr. Smith soon, e.g. tomorrow morning."
        let found = try #require(range(text, 10, .sentence))
        #expect(found.location >= 0 && NSMaxRange(found) <= (text as NSString).length && found.length > 0)
    }

    @Test("a caret in the gap between paragraphs belongs to the next; past them all, to the last")
    func gaps() {
        let text = "One.\n\n\nTwo.\n\n"
        #expect(slice(text, range(text, 5, .paragraph)) == "Two.")
        #expect(slice(text, range(text, (text as NSString).length, .paragraph)) == "Two.")
        #expect(slice(text, range(text, 4, .paragraph)) == "One.", "right after a paragraph's last character")
    }

    @Test("a paragraph keeps its soft-wrapped lines together")
    func softWraps() {
        let text = "First line\nsecond line.\n\nNext."
        #expect(slice(text, range(text, 2, .paragraph)) == "First line\nsecond line.")
    }

    @Test("offsets are UTF-16, so text after an emoji stays aligned")
    func utf16() {
        let text = "😀 First one.\n\nSecond 😀 here. Third."
        let found = range(text, (text as NSString).range(of: "here").location, .sentence)
        #expect(slice(text, found) == "Second 😀 here.")
    }
}
