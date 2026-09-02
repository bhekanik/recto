//
//  VimPresentationTests.swift
//  RectoEditorTests
//
//  The `.vim` presentation over the engine's real text view: the same
//  `keystroke-suite.json` the Bun suite and the RectoVim suites run, driven as
//  `NSEvent`s through `NativeTextView.keyDown`, with `RectoVimController`
//  installed the way the app installs it.
//

import AppKit
import MarkdownEngine
import RectoVim
import RectoVimFixtures
import Testing
@testable import RectoEditor

/// The host's undo as the app would provide it: full-document snapshots, one
/// per `onEdit` outside a command group and one per group. Enough to prove
/// `u`/`<C-r>` round-trip through `RectoEditorHistory` and that an insert
/// session is one step.
@MainActor
final class SnapshotEditorHistory: RectoEditorHistory {
    private let storage: RectoTextStorage
    private(set) var current: String
    private var undoStack: [String] = []
    private var redoStack: [String] = []
    private var groupBase: String?
    private(set) var groupOpen = false
    private(set) var beginCalls = 0
    private(set) var endCalls = 0

    init(storage: RectoTextStorage) {
        self.storage = storage
        current = storage.markdown
    }

    /// Wire to `RectoEditorView.onEdit`.
    func accept(_ edit: RectoEditorEdit) {
        guard !(current as NSString).isEqual(to: edit.markdown) else { return }
        if groupOpen {
            if groupBase == nil { groupBase = current }
        } else {
            undoStack.append(current)
            redoStack.removeAll()
        }
        current = edit.markdown
    }

    /// The host replaced the document from outside (a test resetting a case).
    func reset(to markdown: String) {
        current = markdown
        undoStack.removeAll()
        redoStack.removeAll()
        groupBase = nil
        groupOpen = false
    }

    func beginCommandGroup() {
        beginCalls += 1
        groupOpen = true
        groupBase = nil
    }

    func endCommandGroup() {
        endCalls += 1
        if let groupBase {
            undoStack.append(groupBase)
            redoStack.removeAll()
        }
        groupBase = nil
        groupOpen = false
    }

    func performHistory(_ direction: RectoHistoryDirection) -> RectoHistoryOutcome? {
        let target: String?
        switch direction {
        case .undo:
            target = undoStack.popLast()
            if target != nil { redoStack.append(current) }
        case .redo:
            target = redoStack.popLast()
            if target != nil { undoStack.append(current) }
        }
        guard let target else { return nil }
        let before = current
        current = target
        storage.markdown = target
        return RectoHistoryOutcome(
            markdown: target,
            patchStart: MarkdownTextPatch.diff(from: before, to: target).range.location)
    }
}

@MainActor
@Suite("Vim presentation", .serialized)
struct VimPresentationTests {
    private final class Mounted {
        let harness: WindowHarness
        let storage: RectoTextStorage
        let vim: RectoVimController
        let history: SnapshotEditorHistory
        let textView: NSTextView
        var seam: RectoTextView?
        var edits: [RectoEditorEdit] = []
        var failures: [VimReplayFailure] = []
        var saves = 0

        init(harness: WindowHarness, storage: RectoTextStorage, vim: RectoVimController,
             history: SnapshotEditorHistory, textView: NSTextView) {
            self.harness = harness
            self.storage = storage
            self.vim = vim
            self.history = history
            self.textView = textView
        }

        /// Drive keys the way a keyboard does: every key through
        /// `NSTextView.keyDown`, so what vim declines goes to the input system.
        func press(_ spec: String) throws {
            for key in VimKeys.parse(spec) {
                let event = try #require(key.event, "no NSEvent for \(key.key)")
                textView.keyDown(with: event)
            }
        }

        /// Start a fixture case: new text, fresh vim session, caret placed.
        func begin(_ testCase: KeystrokeSuite.Case) throws {
            vim.attach(to: nil)
            storage.markdown = testCase.text
            history.reset(to: testCase.text)
            edits.removeAll()
            vim.attach(to: seam)
            let offset = utf16Offset(line: testCase.cursor[0], column: testCase.cursor[1], in: testCase.text)
            textView.setSelectedRange(NSRange(location: offset, length: 0))
        }

        func mirrorMatchesStorage() -> Bool {
            (textView.string as NSString).isEqual(to: storage.markdown)
                && (textView.string as NSString).isEqual(to: vim.engineText ?? "")
        }
    }

    private func mount(_ markdown: String) throws -> Mounted {
        let storage = RectoTextStorage(documentId: "vim", markdown: markdown)
        let vim = RectoVimController()
        let history = SnapshotEditorHistory(storage: storage)
        vim.history = history
        var mounted: Mounted?
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .vim, theme: .twilight),
                onAttach: { seam in
                    mounted?.seam = seam
                    vim.attach(to: seam)
                },
                onEdit: { edit in
                    history.accept(edit)
                    mounted?.edits.append(edit)
                }
            ),
            size: CGSize(width: 640, height: 400)
        )
        let textView = try #require(harness.editorTextView)
        let result = Mounted(harness: harness, storage: storage, vim: vim, history: history, textView: textView)
        result.seam = storage.textView
        vim.onReplayFailure = { result.failures.append($0) }
        vim.onSave = { result.saves += 1 }
        mounted = result
        harness.window.makeFirstResponder(textView)
        #expect(vim.isAttached, "the controller must attach through onAttach")
        return result
    }

    // MARK: - The fixture

    @Test("the whole keystroke suite reproduces vim's buffer through the engine view")
    func fixtureReplays() throws {
        let suite = try KeystrokeSuite.load()
        #expect(suite.cases.count >= 150)
        let mounted = try mount("")
        defer { mounted.harness.tearDown() }
        for testCase in suite.cases {
            try mounted.begin(testCase)
            try mounted.press(testCase.keys)
            #expect(
                (mounted.storage.markdown as NSString).isEqual(to: testCase.expectText),
                "\(testCase.name): storage \(describe(mounted.storage.markdown)) expected \(describe(testCase.expectText))")
            #expect(
                (mounted.textView.string as NSString).isEqual(to: testCase.expectText),
                "\(testCase.name): text view \(describe(mounted.textView.string))")
            #expect(
                (mounted.vim.engineText ?? "").utf16.elementsEqual(testCase.expectText.utf16),
                "\(testCase.name): mirror \(describe(mounted.vim.engineText ?? ""))")
            if let expected = testCase.expectMode {
                #expect(mounted.vim.status?.mode == expected, "\(testCase.name): mode")
            }
            if let expected = testCase.expectCursor {
                let head = mounted.textView.selectedRange().location
                #expect(position(of: head, in: mounted.textView.string) == expected,
                        "\(testCase.name): caret")
            }
            if !(testCase.expectText as NSString).isEqual(to: testCase.text) {
                #expect(!mounted.edits.isEmpty, "\(testCase.name): the change must reach onEdit")
            }
        }
        #expect(mounted.failures.isEmpty, "\(mounted.failures)")
    }

    // MARK: - Edit ingress

    @Test("a normal-mode command is one onEdit", arguments: [
        ("dw", "the quick brown fox\n", "quick brown fox\n"),
        ("3dd", "one\ntwo\nthree\nfour\n", "four\n"),
        (":%s/o/0/g<CR>", "one\ntwo\nthree\nfour\n", "0ne\ntw0\nthree\nf0ur\n"),
        ("j3>>", "one\ntwo\nthree\nfour\n", "one\n  two\n  three\n  four\n"),
        ("J", "one\ntwo\n", "one two\n"),
        ("yyp", "one\n", "one\none\n"),
        ("x", "abc\n", "bc\n"),
    ])
    func oneEditPerCommand(keys: String, text: String, expected: String) throws {
        let mounted = try mount(text)
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        mounted.edits.removeAll()

        try mounted.press(keys)

        #expect(mounted.storage.markdown == expected)
        #expect(mounted.edits.count == 1, "\(keys): \(mounted.edits.count) edits")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("an insert session is one edit per character inside one command group")
    func insertSessionIsGrouped() throws {
        let mounted = try mount("tail\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("iabc")
        #expect(mounted.storage.markdown == "abctail\n")
        #expect(mounted.edits.count == 3)
        #expect(mounted.history.beginCalls == 1)
        #expect(mounted.history.groupOpen)

        try mounted.press("<Esc>")
        #expect(mounted.history.endCalls == 1)
        #expect(!mounted.history.groupOpen)
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("no AppKit undo action is ever registered")
    func noAppKitUndo() throws {
        let mounted = try mount("the quick brown fox\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("dwiX<Esc>")

        #expect(!mounted.textView.allowsUndo)
        #expect(mounted.textView.undoManager?.canUndo != true)
    }

    // MARK: - History

    @Test("u and <C-r> run the host's history and put the caret at the change")
    func undoRedoThroughHost() throws {
        let mounted = try mount("the quick brown fox\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 4, length: 0))

        try mounted.press("dw")
        #expect(mounted.storage.markdown == "the brown fox\n")
        try mounted.press("u")
        #expect(mounted.storage.markdown == "the quick brown fox\n")
        #expect(mounted.textView.selectedRange().location == 4)
        #expect(mounted.mirrorMatchesStorage())

        try mounted.press("<C-r>")
        #expect(mounted.storage.markdown == "the brown fox\n")
        #expect(mounted.mirrorMatchesStorage())
        // Undo entries come from the host's stack, never from the redo echo.
        #expect(mounted.edits.count == 1)
    }

    @Test("iabc<Esc>u removes the whole insert session")
    func undoRemovesInsertSession() throws {
        let mounted = try mount("tail\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("iabc<Esc>u")

        #expect(mounted.storage.markdown == "tail\n")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("a cursor key in insert mode moves the engine and breaks the undo block")
    func arrowKeyHandoff() throws {
        let mounted = try mount("tail\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("iab<Left>c<Esc>")
        #expect(mounted.storage.markdown == "acbtail\n")
        #expect(mounted.mirrorMatchesStorage())

        try mounted.press("u")
        #expect(mounted.storage.markdown == "abtail\n")
        try mounted.press("u")
        #expect(mounted.storage.markdown == "tail\n")
    }

    @Test("u with no host history does nothing and stays in sync")
    func undoWithoutHost() throws {
        let mounted = try mount("abc\n")
        defer { mounted.harness.tearDown() }
        mounted.vim.history = nil
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("xu")

        #expect(mounted.storage.markdown == "bc\n")
        #expect(mounted.mirrorMatchesStorage())
    }

    // MARK: - Status, caret, hooks

    @Test("the status carries mode, pending keys, the ex line and messages")
    func statusPayload() throws {
        let mounted = try mount("alpha beta\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        #expect(mounted.vim.status?.label == "")
        #expect(mounted.vim.status?.caret == .block)
        #expect(mounted.seam?.caretShape == .block)

        try mounted.press("3d")
        #expect(mounted.vim.status?.pending == "3d")
        try mounted.press("<Esc>")

        try mounted.press(":s")
        #expect(mounted.vim.status?.prompt == ":s")
        try mounted.press("<Esc>")

        try mounted.press("i")
        #expect(mounted.vim.status?.label == "-- INSERT --")
        #expect(mounted.seam?.caretShape == .bar)
        try mounted.press("<Esc>V")
        #expect(mounted.vim.status?.label == "-- VISUAL LINE --")
        try mounted.press("<Esc>")
    }

    @Test(":w reaches the host's save hook")
    func writeCallsSave() throws {
        let mounted = try mount("alpha\n")
        defer { mounted.harness.tearDown() }
        try mounted.press(":w<CR>")
        #expect(mounted.saves == 1)
        #expect(mounted.storage.markdown == "alpha\n")
    }

    @Test("command chords fall through to AppKit")
    func commandChordsFallThrough() throws {
        let mounted = try mount("abc\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        let event = try #require(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0,
            windowNumber: 0, context: nil, characters: "a", charactersIgnoringModifiers: "a",
            isARepeat: false, keyCode: 0))

        #expect(!mounted.vim.interceptKeyDown(event, in: mounted.textView))
        mounted.textView.keyDown(with: event)
        #expect(mounted.storage.markdown == "abc\n")
    }

    @Test("detaching removes the interceptor and restores the bar caret")
    func detachRestores() throws {
        let mounted = try mount("abc\n")
        defer { mounted.harness.tearDown() }
        mounted.vim.attach(to: nil)

        #expect(mounted.vim.status == nil)
        #expect(mounted.seam?.caretShape == .bar)
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try mounted.press("x")
        #expect(mounted.storage.markdown == "xabc\n", "with vim gone, x is a letter again")
    }

    // MARK: - External changes

    @Test("an external storage change is adopted without echoing back")
    func externalEditSync() throws {
        let mounted = try mount("one\n")
        defer { mounted.harness.tearDown() }
        mounted.storage.markdown = "one\ntwo\n"
        mounted.textView.setSelectedRange(NSRange(location: 4, length: 0))

        try mounted.press("x")

        #expect(mounted.storage.markdown == "one\nwo\n")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.failures.isEmpty)
    }

    // MARK: - Composition (IME)

    private func beginComposition(_ mounted: Mounted, _ marked: String) {
        mounted.textView.setMarkedText(
            marked, selectedRange: NSRange(location: marked.utf16.count, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(mounted.textView.hasMarkedText())
    }

    @Test(
        "keys during a composition belong to the input system, not to vim",
        arguments: ["Space", "CR", "Esc", "BS", "n"])
    func compositionKeysBypassVim(key: String) throws {
        let mounted = try mount("ab\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try mounted.press("i")
        beginComposition(mounted, "ni")

        try mounted.press(key.count == 1 ? key : "<\(key)>")

        mounted.textView.unmarkText()
        #expect(mounted.mirrorMatchesStorage(),
                "\(key): mirror \(describe(mounted.vim.engineText ?? "")) storage \(describe(mounted.textView.string))")
        #expect(mounted.vim.status?.mode == "insert", "\(key): a composition must not leave insert mode")
        #expect(mounted.failures.isEmpty)
    }

    @Test("a committed composition lands in the mirror and keeps insert mode")
    func compositionCommits() throws {
        let mounted = try mount("ab\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try mounted.press("i")
        beginComposition(mounted, "ni")
        mounted.textView.insertText("\u{65E5}", replacementRange: NSRange(location: NSNotFound, length: 0))
        mounted.textView.unmarkText()

        #expect(mounted.storage.markdown == "\u{65E5}ab\n")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.vim.status?.mode == "insert")

        try mounted.press("y<Esc>")
        #expect(mounted.storage.markdown == "\u{65E5}yab\n", "the next key is text, not an operator")
    }

    @Test("normal-mode keys during a composition do not edit the buffer")
    func compositionInNormalMode() throws {
        let mounted = try mount("abc\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        beginComposition(mounted, "ni")
        try mounted.press("x")
        #expect(mounted.textView.string.contains("abc"))
        mounted.textView.unmarkText()
        #expect(mounted.mirrorMatchesStorage())
    }
}

// MARK: - Helpers

private func describe(_ value: String) -> String {
    let units = value.utf16.map { String(format: "%04x", $0) }.joined(separator: " ")
    return "\(value.debugDescription) [\(units)]"
}

/// `[line, ch]` for a UTF-16 offset, matching the fixture's cursor convention.
private func position(of offset: Int, in text: String) -> [Int] {
    let string = text as NSString
    let head = string.substring(to: min(max(offset, 0), string.length))
    let line = head.components(separatedBy: "\n").count - 1
    let lastBreak = (head as NSString).range(of: "\n", options: .backwards)
    let column = lastBreak.location == NSNotFound ? offset : offset - NSMaxRange(lastBreak)
    return [line, column]
}

/// The fixture's `[line, ch]` as a UTF-16 offset. Line endings are vim's:
/// `\n`, `\r\n` or a lone `\r`.
private func utf16Offset(line: Int, column: Int, in text: String) -> Int {
    let units = Array(text.utf16)
    var offset = 0
    var remaining = line
    while remaining > 0, offset < units.count {
        let unit = units[offset]
        offset += 1
        if unit == 0x0A {
            remaining -= 1
        } else if unit == 0x0D {
            if offset < units.count, units[offset] == 0x0A { offset += 1 }
            remaining -= 1
        }
    }
    return offset + column
}
