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
        let writingController: RectoWritingController?
        var edits: [RectoEditorEdit] = []
        var failures: [VimReplayFailure] = []
        var saves = 0

        init(harness: WindowHarness, storage: RectoTextStorage, vim: RectoVimController,
             history: SnapshotEditorHistory, textView: NSTextView,
             writingController: RectoWritingController? = nil) {
            self.harness = harness
            self.storage = storage
            self.vim = vim
            self.history = history
            self.textView = textView
            self.writingController = writingController
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

    private func mount(
        _ markdown: String,
        writingController: RectoWritingController? = nil,
        size: CGSize = CGSize(width: 640, height: 400),
        styler: MarkdownStyler? = nil,
        typewriter: RectoTypewriterController? = nil
    ) throws -> Mounted {
        let styler = styler ?? MarkdownStyler(presentation: .vim, theme: .twilight)
        let storage = RectoTextStorage(documentId: "vim", markdown: markdown)
        let vim = RectoVimController()
        let history = SnapshotEditorHistory(storage: storage)
        vim.history = history
        vim.typewriter = typewriter
        var mounted: Mounted?
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: styler,
                onAttach: { seam in
                    mounted?.seam = seam
                    typewriter?.attach(to: seam)
                    vim.attach(to: seam)
                },
                onEdit: { edit in
                    history.accept(edit)
                    mounted?.edits.append(edit)
                },
                writingController: writingController
            ),
            size: size
        )
        let textView = try #require(harness.editorTextView)
        let result = Mounted(harness: harness, storage: storage, vim: vim, history: history,
                             textView: textView, writingController: writingController)
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

    // MARK: - Declined chords

    @Test("insert-mode chords vim declines do not fall into AppKit's editing commands", arguments: [
        ("<C-h>", "one two\nabove line foo ba\n"),
        ("<C-k>", "one two\nabove line foo bar\n"),
        ("<C-y>", "one two\nabove line foo bar\n"),
    ])
    func declinedInsertChords(chord: String, expected: String) throws {
        // <C-h> is Backspace in vim; <C-k> starts a digraph and <C-y> copies
        // from the line above, neither of which upstream implements. AppKit
        // would have run deleteBackward:, deleteToEndOfParagraph: and yank:
        // (the Emacs kill ring), and the resulting edit dropped vim to normal.
        let mounted = try mount("one two\nabove line\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("jA foo bar" + chord)

        #expect(mounted.storage.markdown == expected, "\(chord): \(describe(mounted.storage.markdown))")
        #expect(mounted.vim.status?.mode == "insert", "\(chord) must leave insert mode alone")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.history.groupOpen, "\(chord) must not end the undo block")
    }

    /// Upstream declines `<CR>` after a pending operator and in visual mode.
    /// The declined keyDown used to reach AppKit's `insertNewline:` and type a
    /// newline — in visual mode replacing the selection. A declined key must
    /// never edit the document.
    @Test("a declined Enter edits nothing, pending or visual", arguments: [
        "d<CR>", "c<CR>", "y<CR>", "g<CR>", "=<CR>", "><CR>", "d2<CR>", "v<CR>",
    ])
    func declinedEnterIsSwallowed(spec: String) throws {
        let mounted = try mount("one\ntwo\nthree\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press(spec)

        #expect(mounted.storage.markdown == "one\ntwo\nthree\n",
                "\(spec): \(describe(mounted.storage.markdown))")
        #expect(mounted.edits.isEmpty, "\(spec) reported an edit")
        #expect(mounted.mirrorMatchesStorage())

        // Out of visual (or with the pending operator cleared), the editor is
        // ready for the next command.
        try mounted.press("<Esc>0x")
        #expect(mounted.storage.markdown == "ne\ntwo\nthree\n")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("insert-mode Enter types the document's line ending", arguments: [
        ("ab\n", "x\nab\n"),
        ("ab\r\n", "x\r\nab\r\n"),
    ])
    func insertEnterTypesDocumentEnding(text: String, expected: String) throws {
        let mounted = try mount(text)
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("ix<CR>")

        #expect((mounted.storage.markdown as NSString).isEqual(to: expected),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.vim.status?.mode == "insert")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("Tab in normal and visual mode edits nothing")
    func tabOutsideInsertIsInert() throws {
        let mounted = try mount("one\ntwo\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("<Tab>")
        #expect(mounted.storage.markdown == "one\ntwo\n")
        try mounted.press("v<Tab><Esc>")
        #expect(mounted.storage.markdown == "one\ntwo\n")
        try mounted.press("i<Tab><Esc>")
        #expect(mounted.storage.markdown == "\tone\ntwo\n", "insert mode still types a tab")
        #expect(mounted.mirrorMatchesStorage())
    }

    // MARK: - Non-US layouts

    /// NSEvent as a layout that composes ASCII punctuation under Option
    /// delivers it (German Option-8 = `{`, Option-9 = `}`).
    private func composedKeyEvent(_ composed: String, _ base: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0,
            windowNumber: 0, context: nil, characters: composed,
            charactersIgnoringModifiers: base, isARepeat: false, keyCode: 0)!
    }

    @Test("Option-composed paragraph motions run against the engine's view")
    func composedLayoutKeysWorkOnTheEngineView() throws {
        let mounted = try mount("one\ntwo\n\nthree\n\n\nfour\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 9, length: 0))

        mounted.textView.keyDown(with: composedKeyEvent("{", "8"))
        #expect(
            mounted.textView.selectedRange().location == 8,
            "German Option-8 must act as `{`, got \(mounted.textView.selectedRange())")
        mounted.textView.keyDown(with: composedKeyEvent("}", "9"))
        #expect(
            mounted.textView.selectedRange().location == 15,
            "German Option-9 must act as `}`, got \(mounted.textView.selectedRange())")
        #expect(mounted.mirrorMatchesStorage())
    }

    // MARK: - Scrolling

    @Test("a search that lands far away brings the caret on screen", arguments: [
        "/Section 30<CR>", "G?Section 12<CR>", "/Section 30<CR>ggn",
    ])
    func searchRevealsCaret(keys: String) throws {
        // The prompt closes outside a vim operation, so the core sends no
        // scrollIntoView for `/` and `?`; motions and `n` do.
        let mounted = try mount(PatchCaretTests.longDocument())
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        mounted.harness.layout()

        try mounted.press(keys)
        mounted.harness.layout()

        let caret = try #require(mounted.storage.textView.caretRect())
        #expect(mounted.textView.visibleRect.intersects(caret),
                "caret \(caret) outside \(mounted.textView.visibleRect) after \(keys)")
        #expect(mounted.textView.selectedRange().location > 0)
    }

    @Test("a controller dropped without detaching leaves no observers behind")
    func deallocationRemovesObservers() throws {
        let storage = RectoTextStorage(documentId: "vim-deinit", markdown: "abc\n")
        var vim: RectoVimController? = RectoVimController()
        weak var weakVim = vim
        let harness = WindowHarness(
            RectoEditorView(storage: storage, styler: MarkdownStyler(presentation: .vim, theme: .twilight),
                            onAttach: { vim?.attach(to: $0) }),
            size: CGSize(width: 640, height: 400))
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        #expect(vim?.isAttached == true)

        vim = nil
        #expect(weakVim == nil, "the seam holds the interceptor weakly")
        #expect(storage.controller.keyInterceptor == nil)
        // Had a text-change block survived with its weak self, this would
        // still be safe; the check is that nothing about the dead controller
        // is reached. Typing plain text now goes straight to AppKit.
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(storage.markdown == "xabc\n")
    }

    // MARK: - Geometry and scrolling

    /// Laid-out row vs font metric. `<C-e>` used the font (~11–18 pt) and
    /// crawled; the visual row on this scale is ~28 pt.
    private func expectLaidOutLineHeight(_ mounted: Mounted) throws -> Double {
        let geometry = VimTextKitGeometry(textView: mounted.textView)
        let font = mounted.textView.font ?? .monospacedSystemFont(ofSize: 17.5, weight: .regular)
        let fontHeight = Double(font.ascender - font.descender + font.leading)
        let laidOut = geometry.lineHeight()
        #expect(laidOut > fontHeight + 4, "lineHeight \(laidOut) vs font \(fontHeight)")
        return laidOut
    }

    private func placeOnSection(_ mounted: Mounted, _ needle: String) throws -> Int {
        let range = (mounted.textView.string as NSString).range(of: needle)
        #expect(range.location != NSNotFound, "missing \(needle)")
        mounted.textView.setSelectedRange(NSRange(location: range.location, length: 0))
        return range.location
    }

    @Test("zz, zt, zb, paging and HML land on the visible line of a 10k-word document")
    func scrollGeometryOnSettledDocument() throws {
        let mounted = try mount(PatchCaretTests.longDocument(), size: CGSize(width: 800, height: 480))
        defer { mounted.harness.tearDown() }
        mounted.harness.layout(passes: 6)
        let geometry = VimTextKitGeometry(textView: mounted.textView)
        let lineH = try expectLaidOutLineHeight(mounted)
        let clip = try #require(mounted.textView.enclosingScrollView?.contentView)

        _ = try placeOnSection(mounted, "Section 200")
        try mounted.press("zz")
        mounted.harness.layout(passes: 2)
        let afterZz = clip.bounds.origin.y
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .center)

        try mounted.press("zt")
        mounted.harness.layout(passes: 2)
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .top)

        try mounted.press("zb")
        mounted.harness.layout(passes: 2)
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .bottom)

        try mounted.press("zz")
        mounted.harness.layout(passes: 2)
        let beforeE = clip.bounds.origin.y
        try mounted.press("<C-e>")
        mounted.harness.layout(passes: 2)
        let eStep = clip.bounds.origin.y - beforeE
        #expect(
            abs(eStep - lineH) < lineH * 0.35,
            "<C-e> stepped \(eStep), laid-out line \(lineH)"
        )

        try mounted.press("<C-y>")
        mounted.harness.layout(passes: 2)
        #expect(abs(clip.bounds.origin.y - afterZz) < lineH * 0.5, "<C-y> should undo <C-e>")

        let client = geometry.scrollInfo().clientHeight
        try mounted.press("zz")
        mounted.harness.layout(passes: 2)
        let beforeF = clip.bounds.origin.y
        try mounted.press("<C-f>")
        mounted.harness.layout(passes: 2)
        #expect(clip.bounds.origin.y - beforeF > client * 0.6, "<C-f> should page by the viewport")

        try mounted.press("zz")
        mounted.harness.layout(passes: 2)
        let beforeD = clip.bounds.origin.y
        try mounted.press("<C-d>")
        mounted.harness.layout(passes: 2)
        let dStep = clip.bounds.origin.y - beforeD
        #expect(
            dStep > client * 0.3 && dStep < client * 0.85,
            "<C-d> stepped \(dStep), client \(client)"
        )

        try mounted.press("<C-u>")
        mounted.harness.layout(passes: 2)
        #expect(clip.bounds.origin.y < beforeD + client * 0.2, "<C-u> should page back up")

        try mounted.press("zz")
        mounted.harness.layout(passes: 2)
        try mounted.press("H")
        expectVisibleBand(mounted, geometry: geometry, band: .top)
        try mounted.press("L")
        expectVisibleBand(mounted, geometry: geometry, band: .bottom)
        try mounted.press("M")
        expectVisibleBand(mounted, geometry: geometry, band: .middle)
    }

    @Test("zz and <C-e> hold their offset within a second of open")
    func scrollGeometryImmediatelyAfterOpen() throws {
        let mounted = try mount(PatchCaretTests.longDocument(), size: CGSize(width: 800, height: 480))
        defer { mounted.harness.tearDown() }
        let geometry = VimTextKitGeometry(textView: mounted.textView)
        let lineH = try expectLaidOutLineHeight(mounted)
        let clip = try #require(mounted.textView.enclosingScrollView?.contentView)

        _ = try placeOnSection(mounted, "Section 180")
        try mounted.press("zz")
        let zzY = clip.bounds.origin.y
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .center)

        mounted.harness.layout(passes: 3)
        #expect(
            abs(clip.bounds.origin.y - zzY) < 1,
            "layout after zz yanked \(clip.bounds.origin.y) off \(zzY)"
        )

        try mounted.press("<C-e>")
        let eY = clip.bounds.origin.y
        #expect(eY - zzY > lineH * 0.5, "<C-e> stepped \(eY - zzY), line \(lineH)")
        mounted.harness.layout(passes: 3)
        #expect(
            abs(clip.bounds.origin.y - eY) < 1,
            "layout after <C-e> yanked \(clip.bounds.origin.y) off \(eY)"
        )
    }

    @Test("gj and gk walk display lines across a wrap in the reading column")
    func displayLineMotionsAcrossWraps() throws {
        let paragraph = String(repeating: "word ", count: 80) + "end\n"
        let mounted = try mount(
            paragraph,
            size: CGSize(width: 900, height: 400),
            styler: MarkdownStyler(presentation: .vim, theme: .twilight, readingWidth: 280)
        )
        defer { mounted.harness.tearDown() }
        mounted.harness.layout(passes: 4)
        let geometry = VimTextKitGeometry(textView: mounted.textView)
        mounted.textView.setSelectedRange(NSRange(location: 12, length: 0))
        let start = geometry.charCoords(offset: 12)
        #expect(start.left > 0)

        try mounted.press("gj")
        let afterDown = mounted.textView.selectedRange().location
        #expect(afterDown > 12, "gj should advance inside the wrapped paragraph")
        let down = geometry.charCoords(offset: afterDown)
        #expect(down.top > start.top + 2, "gj should land on the next display line")
        // Exact: the mono column under the same x. A tolerance of a column here
        // hid a left drift of one column per move.
        #expect(down.left == start.left, "gj should keep the goal column exactly")

        try mounted.press("gk")
        #expect(mounted.textView.selectedRange().location == 12)
    }

    /// The row is 25 columns wide, so column 20 sits at offsets 20, 45, 70, 95.
    @Test("gj and gk keep the exact column over several rows and after a click")
    func displayLineMotionsKeepTheColumn() throws {
        let paragraph = String(repeating: "word ", count: 80) + "end\n"
        let mounted = try mount(
            paragraph,
            size: CGSize(width: 900, height: 400),
            styler: MarkdownStyler(presentation: .vim, theme: .twilight, readingWidth: 280)
        )
        defer { mounted.harness.tearDown() }
        mounted.harness.layout(passes: 4)

        mounted.textView.setSelectedRange(NSRange(location: 20, length: 0))
        try mounted.press("gj")
        #expect(mounted.textView.selectedRange().location == 45)
        try mounted.press("gj")
        #expect(mounted.textView.selectedRange().location == 70)
        try mounted.press("gk")
        try mounted.press("gk")
        #expect(mounted.textView.selectedRange().location == 20)

        // A host move (a click) resets the wanted column, as in Vim; before, the
        // old pixel goal from the previous gj/gk survived it.
        try mounted.press("gj")
        mounted.textView.setSelectedRange(NSRange(location: 30, length: 0))
        try mounted.press("gj")
        try mounted.press("gj")
        #expect(mounted.textView.selectedRange().location == 80)
        try mounted.press("gk")
        try mounted.press("gk")
        #expect(mounted.textView.selectedRange().location == 30)
    }

    private enum CaretPlacement { case top, center, bottom }
    private enum VisibleBand { case top, middle, bottom }

    private func expectCaretPlacement(
        _ mounted: Mounted,
        geometry: VimTextKitGeometry,
        lineH: Double,
        at placement: CaretPlacement,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let offset = mounted.textView.selectedRange().location
        let coords = geometry.charCoords(offset: offset)
        let info = geometry.scrollInfo()
        let mid = (coords.top + coords.bottom) / 2
        let viewMid = info.top + info.clientHeight / 2
        let viewBottom = info.top + info.clientHeight
        let error: Double
        switch placement {
        case .top:
            error = abs(coords.top - info.top)
        case .center:
            error = abs(mid - viewMid)
        case .bottom:
            error = abs(coords.bottom - viewBottom)
        }
        #expect(
            error < lineH * 0.6,
            "\(placement) error \(error) pt, line \(lineH), caret \(coords) view top \(info.top) height \(info.clientHeight)",
            sourceLocation: sourceLocation
        )
    }

    /// `H`/`M`/`L` pick a document line via `coordsChar` at the viewport
    /// edge, then the first non-blank. That is the visible first/middle/last
    /// line, not a pixel-exact edge.
    private func expectVisibleBand(
        _ mounted: Mounted,
        geometry: VimTextKitGeometry,
        band: VisibleBand,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        let coords = geometry.charCoords(offset: mounted.textView.selectedRange().location)
        let info = geometry.scrollInfo()
        let mid = (coords.top + coords.bottom) / 2
        let rel = (mid - info.top) / info.clientHeight
        #expect(coords.bottom > info.top && coords.top < info.top + info.clientHeight,
                sourceLocation: sourceLocation)
        switch band {
        case .top:
            #expect(rel < 0.34, "H relative \(rel)", sourceLocation: sourceLocation)
        case .middle:
            #expect(rel > 0.33 && rel < 0.67, "M relative \(rel)", sourceLocation: sourceLocation)
        case .bottom:
            #expect(rel > 0.66, "L relative \(rel)", sourceLocation: sourceLocation)
        }
    }

    // MARK: - Typewriter interaction

    @Test("typewriter scrolling recenters once per vim command and overrides zt")
    func typewriterRecentersOncePerVimCommand() throws {
        // Typewriter + vim: every command's edit and selection application runs
        // inside performProgrammaticChange, so the recenter count is one per
        // command and the center pass — not vim's own request — owns the frame.
        let typewriter = RectoTypewriterController(isEnabled: true)
        let mounted = try mount(
            PatchCaretTests.longDocument(),
            size: CGSize(width: 640, height: 400),
            typewriter: typewriter
        )
        defer { mounted.harness.tearDown() }
        #expect(mounted.harness.window.makeFirstResponder(mounted.textView))
        mounted.harness.layout(passes: 6)
        let geometry = VimTextKitGeometry(textView: mounted.textView)
        let lineH = try expectLaidOutLineHeight(mounted)
        let baseline = typewriter.recenterCount

        try mounted.press("G")
        mounted.harness.layout(passes: 3)
        #expect(typewriter.recenterCount - baseline == 1, "G must recenter exactly once")


        // `G` parks the caret on the phantom line past the final newline, where
        // charCoords has no fragment; `h` steps onto the last real line.
        // `G` parks the caret on the phantom line past the final newline, where
        // charCoords has no fragment; `k` steps onto the last real line.
        try mounted.press("k")
        mounted.harness.layout(passes: 3)
        #expect(typewriter.recenterCount - baseline == 2, "k must recenter exactly once")
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .center)

        // zz is redundant while typewriter is on: the command's own scroll and
        // the recenter ask for the same frame.
        try mounted.press("zz")
        mounted.harness.layout(passes: 3)
        #expect(typewriter.recenterCount - baseline == 3, "zz must recenter exactly once")
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .center)

        // zt is overridden: the deferred center pass decides where the clip ends.
        try mounted.press("zt")
        mounted.harness.layout(passes: 3)
        #expect(typewriter.recenterCount - baseline == 4, "zt must recenter exactly once")
        try expectCaretPlacement(mounted, geometry: geometry, lineH: lineH, at: .center)
        #expect(mounted.mirrorMatchesStorage())
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

    /// The format toolbar is enabled in `.vim` (`presentation.isEditable`), so
    /// its commands must not desynchronise vim: a bold lands through
    /// `applyPatch` and reaches the layer as an external edit
    /// (`textDidChange` → `setText`) — and the command's selection (the
    /// freshly wrapped word) arrives like any host-driven selection, which is
    /// what visual mode is for upstream.
    @Test("a toolbar bold in vim keeps the mirror in sync")
    func toolbarBoldKeepsMirrorInSync() throws {
        let writing = RectoWritingController()
        let mounted = try mount("plain bold\n", writingController: writing)
        defer { mounted.harness.tearDown() }
        #expect(mounted.writingController != nil)

        // Normal mode: visual-select "bold" the vim way, then bold it.
        mounted.textView.setSelectedRange(NSRange(location: 6, length: 0))
        try mounted.press("ve")
        #expect(mounted.vim.status?.mode == "visual")
        #expect(writing.perform(.bold))
        #expect(mounted.storage.markdown == "plain **bold**\n",
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.failures.isEmpty)

        // Insert mode: a caret at the end gets the empty-selection form.
        try mounted.press("<Esc>$A")
        #expect(mounted.vim.status?.mode == "insert")
        #expect(writing.perform(.bold))
        #expect(mounted.storage.markdown == "plain **bold****text**\n",
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.failures.isEmpty)
    }

    // MARK: - CRLF documents

    @Test("a linewise put in a CRLF document lands once with the document's ending")
    func linewisePutInCRLF() throws {
        let mounted = try mount("alpha\r\nbeta\r\ngamma\r\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        mounted.edits.removeAll()

        try mounted.press("jyyp")

        #expect(Array(mounted.storage.markdown.utf16) == Array("alpha\r\nbeta\r\nbeta\r\ngamma\r\n".utf16),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.edits.count == 1)
        #expect(mounted.vim.status?.mode == "normal")
    }

    @Test("pasting LF text in insert mode in a CRLF document keeps insert mode")
    func insertModePasteInCRLF() throws {
        let mounted = try mount("alpha\r\nbeta\r\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 5, length: 0))

        try mounted.press("i")
        mounted.textView.insertText("X\nY", replacementRange: NSRange(location: NSNotFound, length: 0))

        #expect(Array(mounted.storage.markdown.utf16) == Array("alphaX\r\nY\r\nbeta\r\n".utf16),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.vim.status?.mode == "insert")
        #expect(mounted.failures.isEmpty)
    }

    /// A mixed-ending document: the storage's policy is first-ending-wins
    /// (`MarkdownLineEnding(detecting:)`), and the mirror writes the same
    /// document ending — before, an insert on the minority line typed the
    /// line's own ending, the storage rewrote it, and the normalising resync
    /// dropped insert mode, so the next letters ran as normal-mode commands.
    @Test("an insert-mode paste on an LF line of a mixed document stays in insert")
    func insertPasteOnLFLineOfMixedDocStaysInInsert() throws {
        let mounted = try mount("alpha\r\nbeta\ngamma\r\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 9, length: 0))

        try mounted.press("i")
        mounted.textView.insertText("X\nY", replacementRange: NSRange(location: NSNotFound, length: 0))

        #expect((mounted.storage.markdown as NSString).isEqual(to: "alpha\r\nbeX\r\nYta\ngamma\r\n"),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.vim.status?.mode == "insert", "the normalising resync must not fire")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.failures.isEmpty)
    }

    @Test("typed lines on an LF line of a mixed document land with the storage's ending")
    func typedCRLFOnLFLineOfMixedDoc() throws {
        let mounted = try mount("alpha\r\nbeta\ngamma\r\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 9, length: 0))

        try mounted.press("Ax<CR>y<Esc>")

        #expect((mounted.storage.markdown as NSString).isEqual(to: "alpha\r\nbetax\r\ny\ngamma\r\n"),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
        #expect(mounted.failures.isEmpty)
    }

    @Test("dot-repeat of an insert with a newline replays once in a CRLF document")
    func dotRepeatNewlineInCRLF() throws {
        let mounted = try mount("alpha\r\nbeta\r\ngamma\r\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("ix<CR>y<Esc>j.")

        #expect(Array(mounted.storage.markdown.utf16) == Array("x\r\nyalpha\r\nx\r\nybeta\r\ngamma\r\n".utf16),
                "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
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

    /// An input method's whole round: marked text goes up, then the committed
    /// string replaces it.
    private func commit(_ text: String, in mounted: Mounted) {
        beginComposition(mounted, "ni")
        mounted.textView.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(!mounted.textView.hasMarkedText())
    }

    @Test("an IME commit inside an insert session keeps the session one undo step")
    func compositionKeepsInsertGroup() throws {
        let mounted = try mount("ab\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("ix")
        commit("\u{65E5}", in: mounted)
        try mounted.press("y<Esc>")
        #expect(mounted.storage.markdown == "x\u{65E5}yab\n")
        #expect(mounted.history.beginCalls == 1)
        #expect(mounted.history.endCalls == 1)

        try mounted.press("u")
        #expect(mounted.storage.markdown == "ab\n", "the whole session is one step")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("an IME-only insert session is one undo step")
    func compositionOnlySessionIsGrouped() throws {
        let mounted = try mount("ab\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("i")
        commit("\u{65E5}", in: mounted)
        commit("\u{672C}", in: mounted)
        try mounted.press("<Esc>")
        #expect(mounted.storage.markdown == "\u{65E5}\u{672C}ab\n")
        #expect(mounted.history.beginCalls == 1)

        try mounted.press("u")
        #expect(mounted.storage.markdown == "ab\n")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("dot-repeat replays typed and committed text together")
    func compositionIsPartOfDotRepeat() throws {
        let mounted = try mount("ab\ncd\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))

        try mounted.press("ix")
        commit("\u{65E5}", in: mounted)
        try mounted.press("y<Esc>j0.")

        #expect(mounted.storage.markdown == "x\u{65E5}yab\nx\u{65E5}ycd\n", "\(describe(mounted.storage.markdown))")
        #expect(mounted.mirrorMatchesStorage())
    }

    @Test("a cancelled composition does not swallow the next caret move")
    func cancelledCompositionReleasesSelectionHandoff() throws {
        let mounted = try mount("abcd\n")
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try mounted.press("i")
        beginComposition(mounted, "n")
        // Cancel: the input method takes its marked run back; the text is as
        // it was, so only a selection change reaches the controller.
        mounted.textView.setMarkedText("", selectedRange: NSRange(location: 0, length: 0),
                                       replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(!mounted.textView.hasMarkedText())
        #expect(mounted.storage.markdown == "abcd\n")

        mounted.textView.setSelectedRange(NSRange(location: 3, length: 0))
        try mounted.press("X<Esc>")

        #expect(mounted.storage.markdown == "abcXd\n", "the click moved the engine's caret too")
        #expect(mounted.mirrorMatchesStorage())
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
