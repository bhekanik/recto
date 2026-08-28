#if canImport(AppKit)
import AppKit
import Foundation
import Testing

@testable import RectoVim

/// The bridge's own contract, as opposed to vim's behaviour: line endings,
/// where text input comes from, what happens when replay cannot finish, and the
/// caret after undo. Each of these was a way for the mirror and the storage to
/// drift apart without anything noticing.
@Suite("adapter contract")
@MainActor
struct AdapterContractTests {
    // MARK: - Line endings

    @Test(
        "CRLF documents replay onto the storage unchanged",
        arguments: [
            (name: "x on the second line", text: "a\r\nb\r\n", keys: "jx", expected: "a\r\n\r\n"),
            (name: "dd keeps the other ending", text: "a\r\nb\r\n", keys: "dd", expected: "b\r\n"),
            (name: "J joins across CRLF", text: "a\r\nb\r\n", keys: "J", expected: "a b\r\n"),
            (name: "o uses the document's ending", text: "a\r\nb\r\n", keys: "oX", expected: "a\r\nX\r\nb\r\n"),
            (name: "lone CR", text: "a\rb\r", keys: "jx", expected: "a\r\r"),
            (name: "mixed endings are left alone", text: "a\r\nb\nc\r", keys: "jjx", expected: "a\r\nb\n\r"),
        ])
    func crlfReplay(document: (name: String, text: String, keys: String, expected: String)) throws {
        // A mirror that normalised line endings reported `x` on line 2 of
        // `a\r\nb` as {from: 2, to: 3}, which against the real storage deletes
        // the `\n` of the CRLF rather than the `b`. Both sides have to be
        // indexing the same string.
        let harness = try TextViewHarness(document.text)
        harness.press(document.keys)
        #expect(
            sameCodeUnits(harness.textView.string, document.expected),
            "\(document.name): storage \(describe(harness.textView.string))")
        #expect(sameCodeUnits(harness.textView.string, harness.engine.text()))
        #expect(harness.failures.isEmpty)
    }

    // MARK: - Text input

    @Test("NFD input keeps its combining mark")
    func combiningMarks() throws {
        // A `keyDown` reports one key name; the input system delivers `e` and
        // U+0301 as one `insertText`. Synthesising from the key name dropped the
        // mark entirely.
        let harness = try TextViewHarness("ab\n")
        harness.press("i")
        harness.textView.insertText(
            "e\u{0301}", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(sameCodeUnits(harness.textView.string, "e\u{0301}ab\n"))
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("emoji and ZWJ sequences arrive whole")
    func emojiInput() throws {
        let harness = try TextViewHarness("ab\n")
        harness.press("i")
        for text in ["\u{1F3A9}", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"] {
            harness.textView.insertText(
                text, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
        #expect(
            sameCodeUnits(
                harness.textView.string,
                "\u{1F3A9}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}ab\n"))
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("an IME composition commits and the engine resyncs")
    func markedText() throws {
        // AppKit owns the storage while marked text is up — modelling a
        // composition as vim edits would fight the input system — so the adapter
        // stands aside and takes the storage back afterwards.
        let harness = try TextViewHarness("ab\n")
        harness.press("i")
        harness.textView.setMarkedText(
            "ni", selectedRange: NSRange(location: 2, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(harness.textView.hasMarkedText())
        harness.textView.insertText(
            "\u{65E5}", replacementRange: NSRange(location: NSNotFound, length: 0))
        harness.textView.unmarkText()
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
        #expect(harness.textView.string.contains("\u{65E5}"))
    }

    @Test("dot repeats an insert that came through the input system")
    func dotRepeatsExternalInput() throws {
        let harness = try TextViewHarness("ab\n")
        harness.press("iXY")
        harness.press("<Esc>")
        #expect(harness.textView.string == "XYab\n")
        // The core only learns what was typed by watching the change, which is
        // why `insertText` runs inside `operation()`.
        harness.press("$.")
        #expect(harness.textView.string == "XYaXYb\n")
    }

    // MARK: - Transactional replay

    /// Refuses every change, the way a delegate enforcing a read-only region
    /// would.
    final class VetoingDelegate: NSObject, NSTextViewDelegate {
        nonisolated func textView(
            _ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange,
            replacementString: String?
        ) -> Bool { false }
    }

    @Test("a vetoed edit stops replay and resyncs instead of drifting")
    func delegateVeto() throws {
        let harness = try TextViewHarness("one two three\n")
        let delegate = VetoingDelegate()
        harness.textView.delegate = delegate
        harness.press("dw")

        #expect(harness.failures.count == 1)
        if case .rejectedByDelegate = harness.failures.first {} else {
            Issue.record("expected a delegate rejection, got \(String(describing: harness.failures.first))")
        }
        // The storage is untouched and the engine now agrees with it, rather
        // than holding the deletion it had already committed to its mirror.
        #expect(harness.textView.string == "one two three\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))

        // And the next command works against the real document.
        harness.textView.delegate = nil
        harness.press("dw")
        #expect(harness.textView.string == "two three\n")
    }

    @Test("an out-of-bounds range stops replay and resyncs")
    func rangeOutOfBounds() throws {
        let harness = try TextViewHarness("one two three\n")
        // Someone changed the storage without telling the adapter — the exact
        // situation the invariant is there to catch.
        harness.textView.string = "hi\n"
        harness.press("dw")

        #expect(harness.failures.count == 1)
        if case .rangeOutOfBounds = harness.failures.first {} else {
            Issue.record("expected an out-of-bounds range, got \(String(describing: harness.failures.first))")
        }
        #expect(harness.textView.string == "hi\n")
        #expect(sameCodeUnits(harness.engine.text(), "hi\n"))
    }

    // MARK: - Undo

    @Test("undo leaves the caret where vim leaves it")
    func undoCaret() throws {
        // Vim puts the caret at the start of the change it restored.
        // `NSUndoManager` restores whatever selection it recorded, which in the
        // spike's proof was two lines away.
        let harness = try TextViewHarness("one\ntwo\nthree\n")
        harness.press("jjdd")
        #expect(harness.textView.string == "one\ntwo\n")

        harness.press("u")
        #expect(harness.textView.string == "one\ntwo\nthree\n")
        let restored = try harness.engine.state()
        #expect(restored.primarySelection.head == 8)  // start of "three"
        #expect(VimCaretShape(mode: restored.mode) == .block)
        #expect(harness.textView.selectedRange().location == 8)

        harness.press("<C-r>")
        #expect(harness.textView.string == "one\ntwo\n")
        #expect(try harness.engine.state().primarySelection.head == 8)
    }

    @Test("the first difference is where the patch starts")
    func firstDifference() {
        #expect(VimTextViewAdapter.firstDifference("abc", "abc") == 3)
        #expect(VimTextViewAdapter.firstDifference("abc", "abd") == 2)
        #expect(VimTextViewAdapter.firstDifference("abc", "ab") == 2)
        #expect(VimTextViewAdapter.firstDifference("", "abc") == 0)
    }

    // MARK: - Geometry

    @Test("gj and gk keep the goal column across a soft wrap")
    func goalColumnAcrossWraps() throws {
        // `charCoords` used to report the line fragment's origin for every
        // offset, so every column looked like column zero and `gj` from the
        // middle of a wrapped line landed at its start.
        let paragraph = String(repeating: "word ", count: 60) + "end\n"
        let harness = try TextViewHarness(paragraph, width: 220)
        harness.textView.textContainer?.widthTracksTextView = true
        harness.textView.textLayoutManager?.ensureLayout(
            for: harness.textView.textLayoutManager!.documentRange)

        try harness.adapter.setCursor(line: 0, column: 12)
        let start = harness.adapter.charCoords(offset: 12)
        #expect(start.left > 0, "column 12 should not be at the line's left edge")

        harness.press("gj")
        let afterDown = try harness.engine.state().primarySelection.head
        #expect(afterDown > 12, "gj should move forward within the paragraph")
        let downCoords = harness.adapter.charCoords(offset: afterDown)
        #expect(abs(downCoords.left - start.left) < 12, "the goal column should be kept")

        harness.press("gk")
        #expect(try harness.engine.state().primarySelection.head == 12)
    }

    @Test("offsetAtCoords answers on the display line under the point")
    func offsetAtCoordsUsesTheDisplayLine() throws {
        let paragraph = String(repeating: "word ", count: 60) + "end\n"
        let harness = try TextViewHarness(paragraph, width: 220)
        harness.textView.textContainer?.widthTracksTextView = true
        harness.textView.textLayoutManager?.ensureLayout(
            for: harness.textView.textLayoutManager!.documentRange)

        let coords = harness.adapter.charCoords(offset: 12)
        let roundTripped = harness.adapter.offsetAtCoords(
            left: coords.left, top: coords.top + 1)
        // It used to return the paragraph start for every point in the paragraph.
        #expect(roundTripped > 0)
        #expect(abs(roundTripped - 12) <= 1)
    }
}
#endif
