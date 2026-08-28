#if canImport(AppKit)
import AppKit
import Foundation
import Testing

@testable import RectoVim

/// What happens in insert mode when something other than vim moves the caret or
/// changes the text.
///
/// All three were the same shape of bug: the bridge watched only the *text*, so
/// AppKit could move the selection, rewrite a composition or register an undo
/// action without the engine ever hearing about it. Every case here is driven
/// through a real `NSTextView` — through `adapter.handle(key:)` the arrow never
/// reaches AppKit at all and none of this is visible.
@Suite("insert-mode handoff")
@MainActor
struct InsertModeHandoffTests {
    /// `NSEvent` is not `Sendable`, so the parameterised case below carries the
    /// function-key scalar and builds the event on the main actor.
    static func arrow(_ scalar: Int) -> NSEvent {
        KeyRoutingTests.key(String(UnicodeScalar(UInt32(scalar))!))
    }
    static var left: NSEvent { arrow(NSLeftArrowFunctionKey) }

    // MARK: - Cursor keys

    @Test("a cursor key in insert mode moves the engine, not just the selection")
    func arrowKeyMovesTheEngine() throws {
        // Insert mode declines `<Left>` to AppKit, which moved the selection to
        // offset 1 and left the engine at 2: the next `c` was inserted at the
        // engine's offset, producing `abctail` where vim gives `acbtail`.
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        #expect(harness.textView.string == "abtail\n")

        harness.textView.keyDown(with: Self.left)
        #expect(harness.textView.selectedRange().location == 1)
        #expect(try harness.engine.state().primarySelection.head == 1)
        #expect(try harness.engine.state().insertMode, "the arrow must not leave insert mode")

        harness.textView.keyDown(with: KeyRoutingTests.key("c"))
        #expect(harness.textView.string == "acbtail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("a cursor key starts a new undo block, as stock vim does")
    func arrowKeyBreaksTheUndoBlock() throws {
        // Stock vim: `iab<Left>c<Esc>u` leaves `abtail`, because the arrow ended
        // the first undo block. With the block left open, `u` removed all three.
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        harness.textView.keyDown(with: Self.left)
        harness.textView.keyDown(with: KeyRoutingTests.key("c"))
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        #expect(harness.textView.string == "acbtail\n")

        harness.press("u")
        #expect(harness.textView.string == "abtail\n")
        harness.press("u")
        #expect(harness.textView.string == "tail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("<C-g>U keeps the undo block open across one movement")
    func undoJoinSuppressesTheBreak() throws {
        // Vim's own exception to the rule above, and the reason the decision is
        // made in JS and reported on the result rather than assumed in Swift.
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        harness.textView.keyDown(with: KeyRoutingTests.key("g", .control))
        harness.textView.keyDown(with: KeyRoutingTests.key("U", .shift))
        // Neither key may reach the buffer as text.
        #expect(harness.textView.string == "abtail\n")

        harness.textView.keyDown(with: Self.left)
        harness.textView.keyDown(with: KeyRoutingTests.key("c"))
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        #expect(harness.textView.string == "acbtail\n")

        harness.press("u")
        #expect(harness.textView.string == "tail\n", "the block was asked to continue")
    }

    @Test(
        "every cursor key hands its offset over",
        arguments: [
            (name: "left", scalar: NSLeftArrowFunctionKey),
            (name: "right", scalar: NSRightArrowFunctionKey),
            (name: "up", scalar: NSUpArrowFunctionKey),
            (name: "down", scalar: NSDownArrowFunctionKey),
            (name: "home", scalar: NSHomeFunctionKey),
            (name: "end", scalar: NSEndFunctionKey),
        ])
    func cursorKeysHandOff(input: (name: String, scalar: Int)) throws {
        let harness = try TextViewHarness("one\ntwo\nthree\n")
        try harness.adapter.setCursor(line: 1, column: 1)
        harness.textView.keyDown(with: KeyRoutingTests.key("i"))
        harness.textView.keyDown(with: KeyRoutingTests.key("X"))

        harness.textView.keyDown(with: Self.arrow(input.scalar))
        let moved = try harness.engine.state()
        let caret = harness.textView.selectedRange().location
        #expect(
            moved.primarySelection.head == caret,
            "\(input.name): engine \(moved.primarySelection.head) != selection \(caret)")
        #expect(moved.insertMode, "\(input.name): still insert mode")

        // And the next character lands where the caret now is.
        harness.textView.keyDown(with: KeyRoutingTests.key("Z"))
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
        #expect(
            (harness.textView.string as NSString)
                .substring(with: NSRange(location: caret, length: 1)) == "Z",
            "\(input.name): `Z` landed somewhere else")
    }

    @Test("a click places the engine's caret too")
    func mousePlacementHandsOff() throws {
        // `setSelectedRanges(_:affinity:stillSelecting:)` is the primitive
        // AppKit's own mouse tracking calls; driving it is what a click does.
        let harness = try TextViewHarness("one two three\n")
        harness.textView.setSelectedRanges(
            [NSValue(range: NSRange(location: 8, length: 0))],
            affinity: .downstream, stillSelecting: false)
        #expect(try harness.engine.state().primarySelection.head == 8)

        harness.press("x")
        #expect(harness.textView.string == "one two hree\n")
    }

    @Test("a drag in progress is not handed over until it settles")
    func dragIsNotHandedOverMidGesture() throws {
        let harness = try TextViewHarness("one two three\n")
        harness.textView.setSelectedRanges(
            [NSValue(range: NSRange(location: 0, length: 3))],
            affinity: .downstream, stillSelecting: true)
        #expect(try harness.engine.state().visualMode == false)

        harness.textView.setSelectedRanges(
            [NSValue(range: NSRange(location: 0, length: 3))],
            affinity: .downstream, stillSelecting: false)
        // The core's own `handleExternalSelection` turns a settled selection into
        // visual mode, exactly as it does on the web.
        #expect(try harness.engine.state().visualMode)
    }

    // MARK: - Composition

    private func beginComposition(_ harness: TextViewHarness, _ marked: String) {
        harness.textView.setMarkedText(
            marked, selectedRange: NSRange(location: marked.utf16.count, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(harness.textView.hasMarkedText())
    }

    private func commit(_ harness: TextViewHarness, _ text: String) {
        harness.textView.insertText(
            text, replacementRange: NSRange(location: NSNotFound, length: 0))
        harness.textView.unmarkText()
    }

    @Test("a composition keeps insert mode, during and after")
    func compositionKeepsInsertMode() throws {
        // The first marked-text change used to arrive through `setText`, whose
        // `<Esc>` left the engine in normal mode: after committing the character
        // the next `y` ran as an operator instead of being typed.
        let harness = try TextViewHarness("tail\n")
        harness.textView.keyDown(with: KeyRoutingTests.key("i"))
        harness.textView.keyDown(with: KeyRoutingTests.key("X"))

        beginComposition(harness, "ni")
        #expect(try harness.engine.state().insertMode, "insert mode during the composition")

        commit(harness, "\u{65E5}")
        #expect(harness.textView.string == "X\u{65E5}tail\n")
        #expect(try harness.engine.state().insertMode, "insert mode after the commit")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))

        harness.textView.keyDown(with: KeyRoutingTests.key("y"))
        #expect(harness.textView.string == "X\u{65E5}ytail\n", "`y` was typed, not run as an operator")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("a composition is part of the insert session for undo and redo")
    func compositionUndoAndRedo() throws {
        let harness = try TextViewHarness("tail\n")
        harness.textView.keyDown(with: KeyRoutingTests.key("i"))
        harness.textView.keyDown(with: KeyRoutingTests.key("X"))
        beginComposition(harness, "ni")
        commit(harness, "\u{65E5}")
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        #expect(harness.textView.string == "X\u{65E5}tail\n")

        harness.press("u")
        #expect(harness.textView.string == "tail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))

        harness.press("<C-r>")
        #expect(harness.textView.string == "X\u{65E5}tail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("dot repeats the committed text, not the candidate keys")
    func dotRepeatsTheCommit() throws {
        // Every marked-text update rewrites the whole provisional run, so
        // recording them all would make `.` replay `ni日`. Provisional updates go
        // in under an origin the core ignores; the commit is what gets recorded.
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: KeyRoutingTests.key("i"))
        beginComposition(harness, "ni")
        commit(harness, "\u{65E5}")
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        #expect(harness.textView.string == "\u{65E5}ab\n")

        harness.press("$.")
        #expect(harness.textView.string == "\u{65E5}a\u{65E5}b\n")
    }

    // MARK: - External edits

    /// What a menu command, a drag or a programmatic patch does: ask, mutate,
    /// announce. This is the sequence AppKit itself runs.
    private func externalInsert(_ harness: TextViewHarness, _ text: String, at location: Int) {
        let range = NSRange(location: location, length: 0)
        _ = harness.textView.shouldChangeText(in: range, replacementString: text)
        harness.textView.textStorage?.replaceCharacters(in: range, with: text)
        harness.textView.didChangeText()
        // With `groupsByEvent` on, `NSUndoManager` opens a group for the
        // registration and closes it when the event ends. A test has no event
        // loop, so without this pass the next vim group nests inside the external
        // one and a single `u` takes both.
        RunLoop.current.run(until: Date())
    }

    @Test("an external edit mid-insert is its own undo step")
    func externalEditMidInsertIsItsOwnStep() throws {
        // The external undo action used to be registered while the vim insert
        // group was still open — `didChangeText` closed it only afterwards — so
        // one `u` undid `Z` and `ab` together.
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        #expect(harness.textView.string == "abtail\n")

        externalInsert(harness, "Z", at: 0)
        #expect(harness.textView.string == "Zabtail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))

        harness.press("u")
        #expect(harness.textView.string == "abtail\n", "one `u` undoes the external edit alone")
        harness.press("u")
        #expect(harness.textView.string == "tail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("an external edit mid-insert redoes on its own too")
    func externalEditMidInsertRedo() throws {
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        externalInsert(harness, "Z", at: 0)
        harness.press("u")
        #expect(harness.textView.string == "abtail\n")

        harness.press("<C-r>")
        #expect(harness.textView.string == "Zabtail\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("an external edit before an insert session stays separate")
    func externalEditBeforeInsert() throws {
        let harness = try TextViewHarness("tail\n")
        externalInsert(harness, "Z", at: 0)
        #expect(harness.textView.string == "Ztail\n")

        try harness.adapter.setCursor(line: 0, column: 1)
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        #expect(harness.textView.string == "Zabtail\n")

        harness.press("u")
        #expect(harness.textView.string == "Ztail\n")
        harness.press("u")
        #expect(harness.textView.string == "tail\n")
    }

    @Test("an external edit after an insert session stays separate")
    func externalEditAfterInsert() throws {
        let harness = try TextViewHarness("tail\n")
        for key in ["i", "a", "b"] { harness.textView.keyDown(with: KeyRoutingTests.key(key)) }
        harness.textView.keyDown(with: KeyRoutingTests.key(KeyRoutingTests.escape))
        externalInsert(harness, "Z", at: 0)
        #expect(harness.textView.string == "Zabtail\n")

        harness.press("u")
        #expect(harness.textView.string == "abtail\n")
        harness.press("u")
        #expect(harness.textView.string == "tail\n")
    }
}
#endif
