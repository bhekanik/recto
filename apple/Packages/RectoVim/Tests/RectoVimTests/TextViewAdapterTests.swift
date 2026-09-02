#if canImport(AppKit)
import AppKit
import Foundation
import Testing

import RectoVimFixtures
@testable import RectoVim

/// The same suite again, but driven through a real `NSTextView`.
///
/// The headless suite proves the vim core is right. This proves the *bridge* is:
/// that replaying the edit journal onto `NSTextStorage` leaves the storage byte
/// for byte equal to the engine's own mirror, that the selection lands where the
/// engine said, and that undo sees the changes at all — which it does not if you
/// write to the storage directly.
@Suite("NSTextView adapter")
@MainActor
struct TextViewAdapterTests {
    let suite: KeystrokeSuite

    init() throws {
        suite = try Fixtures.suite()
    }

    @Test("the storage and the engine's mirror stay identical through the suite")
    func mirrorMatchesStorage() throws {
        for testCase in suite.cases {
            let harness = try TextViewHarness(testCase.text)
            try harness.run(testCase)
            #expect(
                sameCodeUnits(harness.textView.string, harness.engine.text()),
                "\(testCase.name): storage \(describe(harness.textView.string)) != mirror \(describe(harness.engine.text()))"
            )
            #expect(
                sameCodeUnits(harness.textView.string, testCase.expectText),
                "\(testCase.name): storage \(describe(harness.textView.string))")
        }
    }

    @Test("undo runs through the text view, not through vim's own history")
    func undoGoesThroughTheHost() throws {
        let harness = try TextViewHarness("the quick brown fox\n")
        harness.press("dw")
        #expect(harness.textView.string == "quick brown fox\n")

        // Direct `textStorage` mutation is invisible to undo; this passing is
        // what says the edits went through shouldChangeText/didChangeText.
        harness.press("u")
        #expect(harness.textView.string == "the quick brown fox\n")
        #expect(sameCodeUnits(harness.textView.string, harness.engine.text()))
    }

    @Test("a batch of edits is one undo step")
    func batchIsOneUndoStep() throws {
        let harness = try TextViewHarness("one\ntwo\nthree\nfour\n")
        harness.press("3dd")
        #expect(harness.textView.string == "four\n")
        harness.press("u")
        // `3dd` is one vim command, so one `u` must bring all three lines back.
        #expect(harness.textView.string == "one\ntwo\nthree\nfour\n")
    }

    @Test("an external edit is adopted without echoing back")
    func externalEditSync() throws {
        let harness = try TextViewHarness("one\n")
        harness.textView.string = "one\ntwo\n"
        harness.textView.setSelectedRange(NSRange(location: 4, length: 0))
        try harness.adapter.syncFromTextView()
        #expect(sameCodeUnits(harness.engine.text(), "one\ntwo\n"))

        harness.press("x")
        #expect(harness.textView.string == "one\nwo\n")
    }

    @Test("emoji clusters survive the round trip to the storage")
    func graphemeRoundTrip() throws {
        for testCase in suite.cases where testCase.text.utf16.count > testCase.text.count {
            let harness = try TextViewHarness(testCase.text)
            try harness.run(testCase)
            #expect(
                sameCodeUnits(harness.textView.string, testCase.expectText),
                "\(testCase.name): \(describe(harness.textView.string))")
            // The characters the reader sees must be whole, not just the bytes
            // equal — a severed ZWJ sequence is still valid UTF-16, so byte
            // equality alone would not catch a clamp that stopped working.
            #expect(
                harness.textView.string.unicodeScalars.allSatisfy { $0.value != 0x200D }
                    || testCase.expectText.unicodeScalars.contains { $0.value == 0x200D },
                "\(testCase.name): a stray ZWJ survived")
        }
    }

    @Test("the block caret is on in normal mode and off in insert mode")
    func caretShapeFollowsMode() throws {
        let harness = try TextViewHarness("one\n")
        var statuses: [VimStatus] = []
        harness.adapter.onStatusChange = { statuses.append($0) }

        harness.press("0")
        #expect(harness.textView.blockCaretWidth != nil)
        harness.press("i")
        #expect(harness.textView.blockCaretWidth == nil)
        #expect(statuses.last?.label == "-- INSERT --")
        #expect(statuses.last?.caret == .bar)
    }
}
#endif
