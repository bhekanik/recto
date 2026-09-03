import AppKit
import MarkdownEngine
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

/// The insert-session undo regime through the real host: an `EditorHostView`
/// with its `DocumentUndoHistory` (and its `GroupClosingUndoManager`), driven
/// by key events the way the menu and the keyboard drive them.
///
/// The rules under test:
/// - The session's group opens at its first text-affecting result, never at
///   mode entry: a bare `i<Esc>` is not an undo step and does not touch the
///   redo stack.
/// - Menu Undo mid-session closes the group coherently (the host tells the
///   controller through `onExternalHistoryNavigation`): the writer stays in
///   insert mode — undo ends the session's STEP, not the session — and the
///   next keystrokes group as one new step.
/// - Detaching mid-insert (a presentation switch) leaves exactly the session's
///   group, no phantom empties.
@Suite("Vim undo regime", .serialized)
@MainActor
struct VimUndoRegimeTests {
    private final class DocumentBox {
        var value: RectoDocument
        init(_ markdown: String) { value = RectoDocument(markdown: markdown) }
    }

    private static let scratchSuite = "com.bhekani.recto.tests.vim-undo"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    @Test("a bare i<Esc> is not an undo step")
    func bareInsertLeavesNoStep() async throws {
        let mounted = try await mountToVim("tail\n")
        defer { mounted.window.close() }
        let undoManager = try #require(mounted.undoManager)
        #expect(!undoManager.canUndo)

        try mounted.press("i")
        try mounted.press("<Esc>")

        #expect(mounted.storage.markdown == "tail\n")
        #expect(!undoManager.canUndo, "a session that typed nothing must leave nothing")
        #expect(!undoManager.canRedo)
        #expect(undoManager.groupingLevel == 0)
        #expect(undoManager.groupsByEvent)
    }

    @Test("a bare i<Esc> between an undo and a redo keeps the redo")
    func bareInsertKeepsRedoStack() async throws {
        let mounted = try await mountToVim("tail\n")
        defer { mounted.window.close() }
        let undoManager = try #require(mounted.undoManager)

        try mounted.press("iab<Esc>")
        #expect(mounted.storage.markdown == "abtail\n")
        try mounted.press("u")
        #expect(mounted.storage.markdown == "tail\n")
        #expect(undoManager.canRedo)

        try mounted.press("i")
        try mounted.press("<Esc>")
        #expect(undoManager.canRedo, "the empty session must not wipe the redo stack")

        try mounted.press("<C-r>")
        #expect(mounted.storage.markdown == "abtail\n")
    }

    @Test("menu Undo at a just-opened empty session changes nothing; the session then groups")
    func menuUndoAtEmptySession() async throws {
        let mounted = try await mountToVim("tail\n")
        defer { mounted.window.close() }
        let undoManager = try #require(mounted.undoManager)

        try mounted.press("i")
        // Edit ▸ Undo with nothing yet typed lands here — canUndo is false, so
        // the pop is a no-op, but the group machinery must not notice either.
        undoManager.undo()

        #expect(mounted.storage.markdown == "tail\n")
        #expect(mounted.vim?.status?.mode == "insert")
        #expect(undoManager.groupingLevel == 0)

        try mounted.press("xy<Esc>")
        #expect(mounted.storage.markdown == "xytail\n")
        try mounted.press("u")
        #expect(mounted.storage.markdown == "tail\n", "x and y are one step")
        #expect(!undoManager.canUndo)
    }

    @Test("menu Undo mid-session ends the step but stays in insert; typing starts a fresh group")
    func menuUndoMidSessionCoherent() async throws {
        let mounted = try await mountToVim("tail\n")
        defer { mounted.window.close() }
        let undoManager = try #require(mounted.undoManager)

        try mounted.press("iab")
        #expect(mounted.storage.markdown == "abtail\n")
        #expect(undoManager.groupingLevel == 1, "the session's group is open")

        undoManager.undo()

        #expect(mounted.storage.markdown == "tail\n")
        #expect(undoManager.groupingLevel == 0)
        #expect(undoManager.groupsByEvent)
        // The design decision: menu Undo mid-insert ends the session's undo
        // step, not the session. `adoptText` carries the landing, not `setText`.
        #expect(mounted.vim?.status?.mode == "insert")

        try mounted.press("cd<Esc>")
        #expect(mounted.storage.markdown == "cdtail\n",
                "continued typing is text, not normal-mode commands: \(mounted.storage.markdown)")
        try mounted.press("u")
        #expect(mounted.storage.markdown == "tail\n", "the fresh group is one step")
        #expect(!undoManager.canUndo)
    }

    @Test("⌃⇧R mid-insert leaves exactly the session's step behind")
    func detachMidInsertLeavesOneStep() async throws {
        let mounted = try await mountToVim("tail\n")
        defer { mounted.window.close() }
        let undoManager = try #require(mounted.undoManager)

        try mounted.press("iab")
        #expect(mounted.storage.markdown == "abtail\n")

        #expect(mounted.press(.rich), "⌃⇧R did not reach the ring")
        await mounted.settle()

        #expect(mounted.vim == nil, "vim is detached in rich")
        #expect(undoManager.groupingLevel == 0, "no open group survives the swap")

        // Exactly one menu Undo reverts the interrupted session; there is no
        // second (phantom empty) step above or below it.
        undoManager.undo()
        #expect(mounted.storage.markdown == "tail\n")
        #expect(undoManager.groupingLevel == 0)
        undoManager.redo()
        #expect(mounted.storage.markdown == "abtail\n")
    }

    // MARK: - Mounting and driving

    @MainActor
    private struct Mounted {
        let storage: RectoTextStorage
        let host: NSView
        let window: NSWindow
        let textView: NSTextView

        var undoManager: UndoManager? { storage.controller.undoManager }
        var vim: RectoVimController? { storage.controller.keyInterceptor as? RectoVimController }

        /// Keys as the keyboard delivers them: `keyDown`, so what vim declines
        /// goes to the input system. Vim notation: `iab<Esc>`, `<C-r>`.
        func press(_ spec: String) throws {
            for event in Self.events(spec) {
                textView.keyDown(with: event)
            }
        }

        /// A lens switch the way the ring's buttons (or the View menu) do it.
        @discardableResult
        func press(_ presentation: Presentation) -> Bool {
            let (key, code): (String, UInt16) = switch presentation {
            case .raw: ("m", 46)
            case .vim: ("v", 9)
            default: ("r", 15)
            }
            let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [.control, .shift],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, characters: key, charactersIgnoringModifiers: key,
                isARepeat: false, keyCode: code
            )!
            return window.performKeyEquivalent(with: event)
        }

        func settle() async {
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async { continuation.resume() }
            }
            host.layoutSubtreeIfNeeded()
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async { continuation.resume() }
            }
        }

        /// No fixture loader on this side of the app boundary: `<Esc>` and
        /// `<C-x>` chords plus literal characters cover these scenarios.
        private static func events(_ spec: String) -> [NSEvent] {
            var events: [NSEvent] = []
            var index = spec.startIndex
            while index < spec.endIndex {
                if spec[index] == "<", let end = spec[index...].firstIndex(of: ">") {
                    let name = spec[spec.index(after: index)..<end]
                    if name == "Esc" {
                        events.append(Self.event("\u{1B}"))
                    } else if name.hasPrefix("C-"), let letter = name.dropFirst(2).first {
                        events.append(Self.event(String(letter), modifiers: [.control]))
                    }
                    index = spec.index(after: end)
                } else {
                    events.append(Self.event(String(spec[index])))
                    index = spec.index(after: index)
                }
            }
            return events
        }

        private static func event(_ characters: String, modifiers: NSEvent.ModifierFlags = []) -> NSEvent {
            NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                windowNumber: 0, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)!
        }
    }

    private func mountToVim(_ markdown: String) async throws -> Mounted {
        _ = NSApplication.shared
        scratch.removePersistentDomain(forName: Self.scratchSuite)
        let document = DocumentBox(markdown)
        let storage = RectoTextStorage(documentId: "vim-undo", markdown: markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document.value }, set: { document.value = $0 }),
            isEditable: true,
            storage: storage,
            settings: StudioSettings(defaults: scratch, systemAppearance: { .dark })
        ).defaultAppStorage(scratch))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        let mounted = Mounted(
            storage: storage, host: host, window: window,
            textView: try #require(storage.textView.nsTextView)
        )
        await mounted.settle()
        #expect(window.makeFirstResponder(mounted.textView))
        #expect(mounted.press(.vim), "⌃⇧V did not reach the ring")
        await mounted.settle()
        // The caret starts at the document head for each scenario.
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        #expect(mounted.vim?.isAttached == true)
        #expect(mounted.vim?.status?.mode == "normal")
        return mounted
    }
}
