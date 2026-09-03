#if canImport(AppKit)
import AppKit
import Foundation
import Testing

@testable import RectoVim

/// Physical keys, through `NSTextView.keyDown` rather than through the adapter's
/// convenience entry point.
///
/// Every other suite calls `adapter.handle(key:)`, which is a fine model of what
/// vim does with a key and no model at all of whether the key ever *reaches*
/// vim. It did not: `start()` installed the input and composition hooks and
/// never installed `keyHook`, so a real text view sent every keystroke straight
/// to AppKit. These drive `NSEvent`s.
@Suite("key routing")
@MainActor
struct KeyRoutingTests {
    /// AppKit needs `characters` and `charactersIgnoringModifiers` to be the
    /// same for an unmodified key; `keyCode` is unused by our translation.
    static func key(_ characters: String, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
            windowNumber: 0, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)!
    }

    static let escape = "\u{1B}"
    static let enter = "\r"
    static let backspace = "\u{7F}"

    /// A key as a layout delivers it when Option composes a different character
    /// than the unmodified base (German Option-8 = `{`, some layouts Option-L = `@`).
    static func composed(_ composed: String, _ base: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0,
            windowNumber: 0, context: nil, characters: composed,
            charactersIgnoringModifiers: base, isARepeat: false, keyCode: 0)!
    }

    @Test("a physical key reaches vim without the caller wiring anything")
    func keyHookIsInstalled() throws {
        let harness = try TextViewHarness("the quick brown fox\n")
        harness.textView.keyDown(with: Self.key("d"))
        harness.textView.keyDown(with: Self.key("w"))
        #expect(harness.textView.string == "quick brown fox\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("printable keys in insert mode go through the input system")
    func printableInputRoundTrip() throws {
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: Self.key("i"))
        harness.textView.keyDown(with: Self.key("X"))
        harness.textView.keyDown(with: Self.key("Y"))
        harness.textView.keyDown(with: Self.key(Self.escape))
        #expect(harness.textView.string == "XYab\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("space, enter and backspace behave in insert mode")
    func insertModeControlKeys() throws {
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: Self.key("i"))
        harness.textView.keyDown(with: Self.key("X"))
        harness.textView.keyDown(with: Self.key(" "))
        harness.textView.keyDown(with: Self.key("Y"))
        harness.textView.keyDown(with: Self.key(Self.backspace))
        harness.textView.keyDown(with: Self.key(Self.enter))
        harness.textView.keyDown(with: Self.key(Self.escape))
        #expect(harness.textView.string == "X \nab\n")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("escape leaves insert mode rather than being typed")
    func escapeLeavesInsertMode() throws {
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: Self.key("i"))
        harness.textView.keyDown(with: Self.key(Self.escape))
        #expect(try harness.engine.state().insertMode == false)
        harness.textView.keyDown(with: Self.key("x"))
        #expect(harness.textView.string == "b\n")
    }

    // MARK: - Composition

    /// Puts the text view into a composition, the way an input method does.
    private func beginComposition(_ harness: TextViewHarness, _ marked: String) {
        harness.textView.setMarkedText(
            marked, selectedRange: NSRange(location: marked.utf16.count, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(harness.textView.hasMarkedText())
    }

    @Test(
        "keys during a composition belong to the input system, not to vim",
        arguments: [
            (name: "space", characters: " "),
            (name: "enter", characters: "\r"),
            (name: "escape", characters: "\u{1B}"),
            (name: "backspace", characters: "\u{7F}"),
            (name: "printable", characters: "n"),
        ])
    func compositionKeysBypassVim(input: (name: String, characters: String)) throws {
        // Space selects a candidate, Return commits, Escape cancels, Backspace
        // deletes a jamo. Handing any of them to vim first stops the composition
        // from committing and leaves the storage holding text the mirror never
        // saw.
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: Self.key("i"))
        beginComposition(harness, "ni")

        harness.textView.keyDown(with: Self.key(input.characters))

        // Whatever AppKit did with it, the mirror must still describe the
        // storage once the composition is over.
        harness.textView.unmarkText()
        #expect(
            sameCodeUnits(harness.engine.text(), harness.textView.string),
            "\(input.name): mirror \(describe(harness.engine.text())) != storage \(describe(harness.textView.string))"
        )
        #expect(harness.failures.isEmpty)
    }

    @Test("a committed composition lands in the mirror")
    func compositionCommits() throws {
        let harness = try TextViewHarness("ab\n")
        harness.textView.keyDown(with: Self.key("i"))
        beginComposition(harness, "ni")
        harness.textView.insertText(
            "\u{65E5}", replacementRange: NSRange(location: NSNotFound, length: 0))
        harness.textView.unmarkText()

        #expect(harness.textView.string.contains("\u{65E5}"))
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    // MARK: - Option-composed layout symbols

    @Test("layout symbols behind Option arrive as their character, not <A-x>", arguments: [
        (base: "8", composed: "{"),
        (base: "9", composed: "}"),
        (base: "5", composed: "["),
        (base: "6", composed: "]"),
        (base: "l", composed: "@"),
    ])
    func optionComposedSymbolsArriveAsTheirCharacters(base: String, composed: String) throws {
        let translated = try #require(VimKeyEvent.translate(Self.composed(composed, base)))
        #expect(translated.key == composed)
        #expect(translated.mods.isEmpty)
    }

    @Test("an Option accent is not a composed symbol and stays <A-x>")
    func usOptionAccentStaysAChord() throws {
        // US Option-a composes "å" into `characters` — non-ASCII, so it is the
        // accent mnemonic, and the core must still see the chord so <A-a>
        // mappings and unhandled fall-through keep working.
        let translated = try #require(VimKeyEvent.translate(Self.composed("å", "a")))
        #expect(translated.key == "a")
        #expect(translated.mods == [.option])
    }

    @Test("a control chord with a composed character keeps its modifier")
    func controlOptionChordStaysAChord() throws {
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero,
            modifierFlags: [.control, .option], timestamp: 0,
            windowNumber: 0, context: nil, characters: "[",
            charactersIgnoringModifiers: "5", isARepeat: false, keyCode: 0)!
        let translated = try #require(VimKeyEvent.translate(event))
        #expect(translated.key == "5")
        #expect(translated.mods == [.control, .option])
    }

    @Test("paragraph motions work when the layout composes them under Option")
    func composedParagraphMotionsWork() throws {
        let harness = try TextViewHarness("one\ntwo\n\nthree\n\n\nfour\n")
        // Caret on the "three" paragraph: `{` to its start, `}` to the next.
        harness.textView.setSelectedRange(NSRange(location: 9, length: 0))
        harness.textView.keyDown(with: Self.composed("{", "8"))
        #expect(
            harness.textView.selectedRange().location == 8,
            "German Option-8 must act as `{`, got \(harness.textView.selectedRange())")
        harness.textView.keyDown(with: Self.composed("}", "9"))
        #expect(
            harness.textView.selectedRange().location == 15,
            "German Option-9 must act as `}`, got \(harness.textView.selectedRange())")
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }

    @Test("normal-mode keys during a composition do not edit the buffer")
    func compositionInNormalMode() throws {
        // A composition should not be possible in normal mode, but if an input
        // method starts one anyway, `x` must not delete a character out from
        // under it.
        let harness = try TextViewHarness("abc\n")
        beginComposition(harness, "ni")
        harness.textView.keyDown(with: Self.key("x"))
        // AppKit may legitimately treat the key as input for the composition.
        // What must hold is that vim did not *also* act on it — the buffer still
        // has its `a` — and that the mirror describes the storage afterwards.
        #expect(harness.textView.string.contains("abc"))
        harness.textView.unmarkText()
        #expect(sameCodeUnits(harness.engine.text(), harness.textView.string))
    }
}
#endif
