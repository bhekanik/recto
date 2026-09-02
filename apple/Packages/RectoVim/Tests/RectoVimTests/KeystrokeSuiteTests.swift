import Foundation
import Testing

@testable import RectoVim

/// The whole keystroke suite, driven through `JSContext` exactly as `keyDown`
/// will drive it — no text view involved.
///
/// This runs the same `fixtures/keystroke-suite.json` the Bun suite runs, so a
/// case that passes there and fails here is a bridge bug, which is a much
/// smaller place to look than "vim is wrong".
@Suite("keystroke suite in JavaScriptCore")
@MainActor
struct KeystrokeSuiteTests {
    let suite: KeystrokeSuite

    init() throws {
        suite = try Fixtures.suite()
    }

    @Test("every case reproduces vim's buffer, caret and mode")
    func everyCase() throws {
        let (engine, history, _) = try Fixtures.engine()
        for testCase in suite.cases {
            let outcome = try run(testCase, engine: engine, history: history)
            #expect(
                sameCodeUnits(outcome.text, testCase.expectText),
                "\(testCase.name): got \(describe(outcome.text)), expected \(describe(testCase.expectText))"
            )
            if let expected = testCase.expectCursor {
                #expect(outcome.cursor == expected, "\(testCase.name): caret")
            }
            if let expected = testCase.expectMode {
                #expect(outcome.mode == expected, "\(testCase.name): mode")
            }
        }
    }

    @Test("the suite is large enough to be evidence")
    func suiteSize() {
        #expect(suite.cases.count >= 100)
    }

    @Test("emoji clusters survive every editing command")
    func graphemeCases() throws {
        // The spike's finding was that the core clips to code points, so these
        // silently corrupted. They are the acceptance criterion for N3, and a
        // suite that quietly lost them would still be green above.
        let clusters = suite.cases.filter { $0.text.utf16.count > $0.text.count }
        #expect(clusters.count >= 15)
        let (engine, history, _) = try Fixtures.engine()
        for testCase in clusters {
            let outcome = try run(testCase, engine: engine, history: history)
            #expect(
                sameCodeUnits(outcome.text, testCase.expectText),
                "\(testCase.name): got \(describe(outcome.text))")
        }
    }

    @Test("every offset the engine reports sits on a grapheme boundary")
    func selectionsAreClamped() throws {
        // `src/grapheme.js` (UAX #29) and `GraphemeClamp` (ICU) are two different
        // implementations, and the adapters trust the first while the app uses
        // the second. This is where a disagreement shows up as a red test rather
        // than as mangled text.
        let (engine, history, _) = try Fixtures.engine()
        for testCase in suite.cases where testCase.text.utf16.count > testCase.text.count {
            _ = try run(testCase, engine: engine, history: history)
            let text = engine.text() as NSString
            let state = try engine.state()
            for selection in state.selections {
                #expect(
                    GraphemeClamp.isBoundary(in: text, offset: selection.anchor),
                    "\(testCase.name): anchor \(selection.anchor) is mid-cluster")
                #expect(
                    GraphemeClamp.isBoundary(in: text, offset: selection.head),
                    "\(testCase.name): head \(selection.head) is mid-cluster")
            }
        }
    }

    @Test("registers and marks survive a restart")
    func persistence() throws {
        let (engine, history, _) = try Fixtures.engine()
        try engine.start(text: "alpha\nbeta\n")
        try engine.setCursor(line: 0, column: 0)
        for key in VimKeys.parse("\"ayy") {
            history.beginKey()
            history.endKey(try engine.handleKey(key.key, modifiers: key.modifiers))
        }
        let saved = engine.saveState()
        #expect(saved.contains("alpha"))

        let (second, secondHistory, _) = try Fixtures.engine()
        try second.start(text: "gamma\n")
        try second.setCursor(line: 0, column: 0)
        second.restoreState(saved)
        for key in VimKeys.parse("\"ap") {
            secondHistory.beginKey()
            secondHistory.endKey(try second.handleKey(key.key, modifiers: key.modifiers))
        }
        #expect(sameCodeUnits(second.text(), "gamma\nalpha\n"))
    }

    @Test("mappings go through the engine")
    func mappings() throws {
        let (engine, history, _) = try Fixtures.engine()
        try engine.start(text: "the quick brown fox\n")
        try engine.setCursor(line: 0, column: 0)
        engine.noremap("Q", to: "dw")
        history.beginKey()
        history.endKey(try engine.handleKey("Q", modifiers: .shift))
        #expect(sameCodeUnits(engine.text(), "quick brown fox\n"))
    }

    @Test("an unbound key is declined so the text view can have it")
    func unhandledKeysFallThrough() throws {
        let (engine, _, _) = try Fixtures.engine()
        try engine.start(text: "one\n")
        try engine.setCursor(line: 0, column: 0)
        // Normal mode swallows plain text, but an unbound chord or function key
        // must come back declined, or system shortcuts and IME would stop
        // working while the vim lens is on.
        #expect(try engine.handleKey("z", modifiers: .control).handled == false)
        #expect(try engine.handleKey("F5").handled == false)
        // `<C-q>` is an alias for `<C-v>` upstream, so it is *not* free — a
        // reminder that "looks unbound" is not the same as unbound.
        #expect(try engine.handleKey("q", modifiers: .control).handled)
    }

    @Test("the ex line is reported for the status bar")
    func exLine() throws {
        let (engine, _, _) = try Fixtures.engine()
        try engine.start(text: "one\n")
        try engine.setCursor(line: 0, column: 0)
        _ = try engine.handleKey(":")
        let state = try engine.handleKey("s")
        #expect(state.prompt?.prefix == ":")
        #expect(state.prompt?.value == "s")
        #expect(VimStatus(result: state).prompt == ":s")
    }

    @Test(":w asks the host to save and leaves the buffer alone")
    func writeCallsHost() throws {
        let (engine, _, host) = try Fixtures.engine()
        var saves = 0
        host.onSave = { saves += 1 }
        try engine.start(text: "alpha\n")
        try engine.setCursor(line: 0, column: 0)
        var last = try engine.state()
        for key in VimKeys.parse(":w<CR>") {
            last = try engine.handleKey(key.key, modifiers: key.modifiers)
        }
        #expect(saves == 1)
        #expect(last.edits.isEmpty)
        #expect(last.mode == "normal")
        #expect(sameCodeUnits(engine.text(), "alpha\n"))
    }

    @Test("the bundle resolves from the package's own resources")
    func bundledResource() throws {
        // Not the same lookup as the tests' `Fixtures.bundleURL`: this is the
        // one the app uses, and it broke silently once already when the resource
        // directory had to be renamed for iOS codesigning.
        let url = try VimEngine.bundledScriptURL()
        #expect(FileManager.default.fileExists(atPath: url.path))
        let engine = try VimEngine(host: VimHost())
        #expect(engine.version.contains("+"))
    }

    @Test("load is fast enough to do at document open")
    func loadDuration() throws {
        let (engine, _, _) = try Fixtures.engine()
        #expect(engine.loadDuration < 0.1)
        #expect(engine.version.contains("+"))
    }

    // MARK: - Runner

    struct Outcome {
        let text: String
        let cursor: [Int]
        let mode: String
    }

    func run(_ testCase: KeystrokeSuite.Case, engine: VimEngine, history: SnapshotHistory) throws
        -> Outcome
    {
        try engine.start(text: testCase.text)
        try engine.setCursor(line: testCase.cursor[0], column: testCase.cursor[1])
        var last = try engine.state()
        for key in VimKeys.parse(testCase.keys) {
            history.beginKey()
            last = try engine.handleKey(key.key, modifiers: key.modifiers)
            history.endKey(last)
        }
        let text = engine.text()
        return Outcome(
            text: text, cursor: position(of: last.primarySelection.head, in: text),
            mode: last.mode)
    }
}
