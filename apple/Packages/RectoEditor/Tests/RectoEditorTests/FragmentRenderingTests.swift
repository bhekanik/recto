//
//  FragmentRenderingTests.swift
//  RectoEditorTests
//
//  Several canonical constructs are not in the text at all: bullets, ordered
//  numbers, task boxes, thematic-break rules, code-block fills and table
//  bitmaps are DRAWN by the engine's `NSTextLayoutFragment` subclass, keyed off
//  attributes. The corpus snapshots cannot see any of it — they call the styler
//  with no view, window, layout manager or draw, so deleting every one of those
//  draws leaves them green.
//
//  These mount a real window at a fixed size and appearance and look at the
//  pixels where the decoration belongs. They are deliberately coarse: "is
//  anything drawn in the marker slot", "does a checked box look different from
//  an unchecked one". A pixel-exact baseline would fail on every font update
//  and teach people to re-record it without reading.
//

import AppKit
import Foundation
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
// AppKit windows are process-global; these must not run concurrently.
@Suite("Layout-fragment drawing", .serialized)
struct FragmentRenderingTests {

    private func mount(_ markdown: String,
                       _ presentation: Presentation = .rich) -> WindowHarness {
        let storage = RectoTextStorage(documentId: "fragment", markdown: markdown)
        let styler = MarkdownStyler(presentation: presentation, theme: .twilight)
        return WindowHarness(RectoEditorView(storage: storage, styler: styler))
    }

    /// How much ink sits in the marker slot of the line at `location`.
    /// `nil` when the line has no marker slot at all (a paragraph).
    private func gutterInk(_ markdown: String, at location: Int = 0) -> Double? {
        let harness = mount(markdown)
        defer { harness.tearDown() }
        guard let gutter = harness.markerGutter(
            forCharacterRange: NSRange(location: location, length: 0)) else { return nil }
        return harness.inkCoverage(in: gutter)
    }

    // MARK: - Drawn markers

    @Test("a paragraph has no marker slot, and a list item does")
    func onlyListsReserveAMarkerSlot() {
        #expect(gutterInk("one\n") == nil)
        #expect(gutterInk("- one\n") != nil)
    }

    @Test("a bullet is drawn in the marker slot")
    func bulletIsDrawn() {
        // The `-` is kerned to zero width and painted clear, and the text is
        // indented past the slot — so any ink here is the drawn glyph and
        // nothing else.
        let ink = gutterInk("- one\n")
        #expect((ink ?? 0) > 0.002, "no bullet glyph was drawn: the marker slot is empty")
    }

    @Test("an ordered number is drawn, and more digits means more ink")
    func orderedNumberIsDrawn() {
        let one = gutterInk("1. one\n") ?? 0
        let ten = gutterInk("10. one\n") ?? 0
        #expect(one > 0.002, "no ordered marker was drawn")
        // Two digits cannot look the same as one unless nothing is being drawn.
        #expect(ten > one + 0.002, "the ordered marker does not follow its number")
    }

    @Test("a task box is drawn, and checked differs from unchecked")
    func taskBoxIsDrawn() {
        let unchecked = gutterInk("- [ ] one\n") ?? 0
        let checked = gutterInk("- [x] one\n") ?? 0
        #expect(unchecked > 0.002, "no task box was drawn")
        #expect(abs(checked - unchecked) > 0.003,
                "a checked box renders identically to an unchecked one")
    }

    @Test("a thematic break draws a rule even though every character is hidden")
    func thematicBreakIsDrawn() {
        // All three characters of `***` are hidden, so ink on this line can
        // only be the drawn rule.
        let harness = mount("Before\n\n***\n\nAfter\n")
        defer { harness.tearDown() }
        let breakLocation = ("Before\n\n" as NSString).length
        guard let line = harness.rect(
            forCharacterRange: NSRange(location: breakLocation, length: 0)) else {
            Issue.record("no layout fragment for the thematic break")
            return
        }
        #expect(harness.inkCoverage(in: line) > 0.01, "the thematic break drew nothing")
    }

    @Test("a fenced code block paints a background behind its text")
    func codeBlockBackgroundIsDrawn() {
        let harness = mount("Before\n\n```swift\nlet x = 1\n```\n\nAfter\n")
        defer { harness.tearDown() }
        let codeLocation = ("Before\n\n```swift\n" as NSString).length
        guard let codeLine = harness.rect(
            forCharacterRange: NSRange(location: codeLocation, length: 0)),
            let proseLine = harness.rect(forCharacterRange: NSRange(location: 0, length: 0))
        else {
            Issue.record("no layout fragments for the code block")
            return
        }
        // The fill runs the full container width, so sample well right of any
        // glyph. Absolute brightness, not coverage: a uniformly filled rect has
        // no internal contrast at all, which is exactly what coverage measures.
        func rightMargin(_ rect: NSRect) -> NSRect {
            NSRect(x: rect.maxX - 60, y: rect.minY, width: 50, height: max(1, rect.height))
        }
        let code = harness.averageBrightness(in: rightMargin(codeLine))
        let prose = harness.averageBrightness(in: rightMargin(proseLine))
        #expect(code > prose + 0.01,
                "the code block's right margin is as dark as bare sheet — no background painted")
    }

    @Test("a table renders as a drawn block, not as its collapsed source")
    func tableIsDrawn() {
        let harness = mount("| year | depth |\n| --- | --- |\n| 1900 | 12 |\n")
        defer { harness.tearDown() }
        guard let line = harness.rect(forCharacterRange: NSRange(location: 0, length: 0)) else {
            Issue.record("no layout fragment for the table")
            return
        }
        // The pipe source collapses under an anchor; what is on screen is the
        // rendered bitmap, far taller than one collapsed line.
        #expect(line.height > 30, "the table block collapsed to a single line — no bitmap drawn")
        #expect(harness.inkCoverage(in: line) > 0.02, "the table drew nothing")
    }

    // MARK: - Caret, selection, hit testing

    @Test("the caret entering a heading reveals its markers on screen")
    func caretRevealIsVisible() throws {
        let harness = mount("## Section\n\nBody.\n")
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        // The title's own start position: with the markers collapsed it sits at
        // the left edge, and revealing them has to push it right by the width
        // of `## `. Geometry rather than pixels — the two states differ by a
        // couple of glyphs in a 100 pt band, which is below the noise floor of
        // a coverage comparison (measured: it moved 0.0008 the wrong way).
        func titleStart() -> CGFloat {
            textView.firstRect(forCharacterRange: NSRange(location: 3, length: 7),
                               actualRange: nil).origin.x
        }
        func markerSize() -> CGFloat {
            (textView.textStorage?
                .attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize ?? 0
        }

        textView.setSelectedRange(NSRange(location: 14, length: 0))
        harness.layout()
        let hiddenSize = markerSize()
        let hiddenStart = titleStart()

        textView.setSelectedRange(NSRange(location: 4, length: 0))
        harness.layout()
        let revealedSize = markerSize()
        let revealedStart = titleStart()

        #expect(hiddenSize < 1, "the `##` was not hidden with the caret elsewhere")
        #expect(revealedSize > 16, "the `##` did not grow back when the caret entered the line")
        #expect(revealedStart > hiddenStart + 10,
                "the markers changed size but the title did not move — nothing was laid out")
    }

    @Test("a selection is painted")
    func selectionIsPainted() {
        let harness = mount("alpha bravo charlie delta\n")
        defer { harness.tearDown() }
        guard let textView = harness.editorTextView,
              let line = harness.rect(forCharacterRange: NSRange(location: 0, length: 0)) else {
            Issue.record("no editor")
            return
        }
        let unselected = harness.inkCoverage(in: line)
        textView.setSelectedRange(NSRange(location: 0, length: 25))
        harness.layout()
        #expect(harness.inkCoverage(in: line) > unselected + 0.05, "no selection wash was drawn")
    }

    @Test("hit testing maps a point on the line back to a character")
    func hitTestingWorks() {
        let harness = mount("alpha bravo charlie\n")
        defer { harness.tearDown() }
        guard let textView = harness.editorTextView,
              let line = harness.textViewRect(
                forCharacterRange: NSRange(location: 0, length: 0)) else {
            Issue.record("no editor")
            return
        }
        // The text view's own coordinates, which is what this API takes.
        // Near the TOP of the fragment: its frame includes the paragraph
        // spacing below the glyphs, so `midY` lands under the text and every
        // point maps to the end of the document (measured).
        func index(atFraction fraction: CGFloat) -> Int {
            textView.characterIndexForInsertion(
                at: NSPoint(x: line.minX + line.width * fraction, y: line.minY + 8))
        }
        // Relative, not absolute: the exact index depends on the face's
        // metrics, but a click further right must land further into the line.
        #expect(index(atFraction: 0.05) < index(atFraction: 0.4),
                "hit testing does not follow the horizontal position")
        #expect(index(atFraction: 0.4) < index(atFraction: 0.9))
        #expect(index(atFraction: 0.9) <= ("alpha bravo charlie\n" as NSString).length)
    }

    @Test("preview draws the document but takes no caret")
    func previewIsReadOnly() {
        let harness = mount("## Section\n\n- one\n", .preview)
        defer { harness.tearDown() }
        guard let textView = harness.editorTextView else {
            Issue.record("no editor")
            return
        }
        #expect(textView.isEditable == false)
        #expect(textView.isSelectable, "preview must still allow copying")
        // Markers stay hidden wherever the selection is put, because the styler
        // is given no caret at all when the view is not editable.
        guard let line = harness.rect(forCharacterRange: NSRange(location: 0, length: 0)) else {
            Issue.record("no layout")
            return
        }
        let hidden = harness.inkCoverage(in: line)
        textView.setSelectedRange(NSRange(location: 4, length: 0))
        harness.layout()
        #expect(abs(harness.inkCoverage(in: line) - hidden) < 0.005,
                "preview revealed markers for a selection")
    }
}
