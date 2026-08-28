#if canImport(UIKit)
import Foundation
import Testing
import UIKit

@testable import RectoVim

/// The UIKit half of the insert-mode handoff contract.
///
/// The same three failures as on AppKit, and the same fixes, but UIKit has no
/// pre-mutation funnel and no `BlockCaretTextView` to hook, so the handoffs are
/// public adapter calls the host makes from `textViewDidChangeSelection(_:)`,
/// its own change hook and before a programmatic edit. These tests are that
/// contract.
@Suite("insert-mode handoff (UIKit)")
@MainActor
struct UIInsertModeHandoffTests {
    // MARK: - Cursor keys

    @Test("a cursor key in insert mode moves the engine, not just the selection")
    func caretHandoffMovesTheEngine() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iab")
        #expect(harness.textView.text == "abtail\n")

        harness.moveCaret(to: 1)
        #expect(try harness.engine.state().primarySelection.head == 1)
        #expect(try harness.engine.state().insertMode)

        harness.adapter.insertText("c")
        #expect(harness.textView.text == "acbtail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))
    }

    @Test("a cursor key starts a new undo block, as stock vim does")
    func caretHandoffBreaksTheUndoBlock() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iab")
        harness.moveCaret(to: 1)
        harness.adapter.insertText("c")
        harness.press("<Esc>")
        #expect(harness.textView.text == "acbtail\n")

        harness.press("u")
        #expect(harness.textView.text == "abtail\n")
        harness.press("u")
        #expect(harness.textView.text == "tail\n")
    }

    @Test("<C-g>U keeps the undo block open across one movement")
    func undoJoinSuppressesTheBreak() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iab<C-g>U")
        #expect(harness.textView.text == "abtail\n", "neither key reaches the buffer")

        harness.moveCaret(to: 1)
        harness.adapter.insertText("c")
        harness.press("<Esc>")
        harness.press("u")
        #expect(harness.textView.text == "tail\n", "the block was asked to continue")
    }

    @Test("a settled selection enters visual mode, a caret does not")
    func selectionHandoffEntersVisualMode() throws {
        let harness = try UITextViewHarness("one two three\n")
        harness.textView.selectedRange = NSRange(location: 0, length: 3)
        harness.adapter.selectionDidChangeExternally()
        #expect(try harness.engine.state().visualMode)

        harness.moveCaret(to: 8)
        #expect(try harness.engine.state().visualMode == false)
        #expect(try harness.engine.state().primarySelection.head == 8)
    }

    // MARK: - Composition

    /// One composition, the way an input method drives it: marked text, then a
    /// commit that replaces the marked run. The host reports each change.
    private func compose(_ harness: UITextViewHarness, marked: String, commit: String) throws {
        harness.textView.setMarkedText(
            marked, selectedRange: NSRange(location: marked.utf16.count, length: 0))
        try harness.adapter.syncCompositionFromTextView()
        harness.textView.insertText(commit)
        try harness.adapter.syncCompositionFromTextView()
    }

    @Test("a composition keeps insert mode, during and after")
    func compositionKeepsInsertMode() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iX")

        // UIKit owns the storage while marked text is up; the host reports the
        // change and the adapter adopts it without cancelling insert mode.
        harness.textView.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0))
        try harness.adapter.syncCompositionFromTextView()
        #expect(try harness.engine.state().insertMode, "insert mode during the composition")

        harness.textView.insertText("\u{65E5}")
        try harness.adapter.syncCompositionFromTextView()
        #expect(harness.textView.text == "X\u{65E5}tail\n")
        #expect(try harness.engine.state().insertMode, "insert mode after the commit")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))

        harness.press("y")
        #expect(
            harness.textView.text == "X\u{65E5}ytail\n",
            "`y` was typed, not run as an operator")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))
    }

    @Test("undo after a composition keeps the engine and the storage together")
    func compositionUndoAndRedo() throws {
        // Deliberately not an assertion about the resulting *text*.
        // `UITextView`'s own undo of a committed composition restores the wrong
        // range with no vim layer present at all: `X`, marked `ni`, commit `日`,
        // undo gives `Xil`. That is UIKit's, not ours, and the iOS host will run
        // undo through `RectoHistory` rather than the text view's undo manager.
        // What the adapter owns is that the engine follows whatever the undo
        // manager did. AppKit's equivalent, where the undo is sound, asserts the
        // text itself.
        let harness = try UITextViewHarness("tail\n")
        harness.press("iX")
        try compose(harness, marked: "ni", commit: "\u{65E5}")
        harness.press("<Esc>")
        #expect(harness.textView.text == "X\u{65E5}tail\n")

        harness.press("u")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))
        harness.press("<C-r>")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))
        #expect(harness.failures.isEmpty)
    }

    @Test("dot repeats the committed text, not the candidate keys")
    func dotRepeatsTheCommit() throws {
        let harness = try UITextViewHarness("ab\n")
        harness.press("i")
        try compose(harness, marked: "ni", commit: "\u{65E5}")
        harness.press("<Esc>")
        #expect(harness.textView.text == "\u{65E5}ab\n")

        harness.press("$.")
        #expect(harness.textView.text == "\u{65E5}a\u{65E5}b\n")
    }

    // MARK: - External edits

    @Test("an external edit mid-insert is its own undo step")
    func externalEditMidInsertIsItsOwnStep() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iab")
        harness.externalInsert("Z", at: 0)
        #expect(harness.textView.text == "Zabtail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.text ?? ""))

        harness.press("u")
        #expect(harness.textView.text == "abtail\n", "one `u` undoes the external edit alone")
        harness.press("u")
        #expect(harness.textView.text == "tail\n")
    }

    @Test("an external edit before an insert session stays separate")
    func externalEditBeforeInsert() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.externalInsert("Z", at: 0)
        try harness.adapter.setCursor(line: 0, column: 1)
        harness.press("iab<Esc>")
        #expect(harness.textView.text == "Zabtail\n")

        harness.press("u")
        #expect(harness.textView.text == "Ztail\n")
        harness.press("u")
        #expect(harness.textView.text == "tail\n")
    }

    @Test("an external edit after an insert session stays separate")
    func externalEditAfterInsert() throws {
        let harness = try UITextViewHarness("tail\n")
        harness.press("iab<Esc>")
        harness.externalInsert("Z", at: 0)
        #expect(harness.textView.text == "Zabtail\n")

        harness.press("u")
        #expect(harness.textView.text == "abtail\n")
        harness.press("u")
        #expect(harness.textView.text == "tail\n")
    }
}
#endif
