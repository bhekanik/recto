import AppKit
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

@Suite("Presentation preference", .serialized)
@MainActor
struct PresentationPreferenceTests {
    private final class DocumentBox {
        var value: RectoDocument
        var writes = 0

        init(_ markdown: String) {
            value = RectoDocument(markdown: markdown)
        }
    }

    /// A suite of its own: the test host is the real app, and its standard
    /// defaults are the developer's own preference. Emptied before and after
    /// every test so nothing outlives the run on disk.
    private static let scratchSuite = "com.bhekani.recto.tests.presentation"

    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    @Test("absent or unusable stored values fall back to rich", arguments: [
        nil, "", "vim", "RAW", "preview",
    ])
    func fallsBackToRich(stored: String?) {
        #expect(PresentationPreference.choice(from: stored) == .rich)
        #expect(PresentationPreference.presentation(stored: stored, isEditable: true) == .rich)
    }

    @Test("a stored choice round-trips through its raw value", arguments: PresentationPreference.choices)
    func roundTrips(choice: Presentation) {
        #expect(PresentationPreference.choice(from: choice.rawValue) == choice)
        #expect(PresentationPreference.presentation(stored: choice.rawValue, isEditable: true) == choice)
    }

    @Test("a read-only document is previewed whatever is stored", arguments: [nil, "rich", "raw", "preview"])
    func readOnlyIsPreview(stored: String?) {
        #expect(PresentationPreference.presentation(stored: stored, isEditable: false) == .preview)
        #expect(PresentationPreference.presentation(chosen: .raw, stored: stored, isEditable: false) == .preview)
    }

    @Test("a window's own choice outranks the stored default", arguments: PresentationPreference.choices)
    func windowChoiceWins(choice: Presentation) {
        #expect(PresentationPreference.presentation(chosen: choice, stored: "rich", isEditable: true) == choice)
        #expect(PresentationPreference.presentation(chosen: choice, stored: "raw", isEditable: true) == choice)
        #expect(PresentationPreference.presentation(chosen: nil, stored: "raw", isEditable: true) == .raw)
    }

    @Test("a read-only document ignores a stored raw choice on screen")
    func readOnlyDocumentIgnoresStoredRaw() async throws {
        _ = NSApplication.shared
        defer { scratch.removePersistentDomain(forName: Self.scratchSuite) }
        scratch.set(Presentation.raw.rawValue, forKey: PresentationPreference.key)
        let source = "# Read only\n"
        let document = DocumentBox(source)
        let storage = RectoTextStorage(documentId: "read-only-raw", markdown: source)
        let (host, window) = mount(document, storage: storage, isEditable: false, defaults: scratch)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        let textView = try #require(storage.textView.nsTextView)
        #expect(!textView.isEditable)
        #expect(markerIsHidden(in: textView), "preview must hide the heading marker; raw would show it")
    }

    @Test(
        "switching rich → raw → rich keeps the bytes, the selection and the undo history",
        arguments: [
            "# Title 🧑🏽‍💻 cafe\u{301}\n\n- one\n- [ ] two ✅\n\n```sh|bash\necho \"a | b\"\n```\n\n> quote\n\nlast line",
            "# Title 🧑🏽‍💻 cafe\u{301}\r\n\r\n- one\r\n- [ ] two ✅\r\n\r\n```sh|bash\r\necho \"a | b\"\r\n```\r\n\r\n> quote\r\n\r\nlast line",
        ]
    )
    func switchingPresentationLeavesDocumentUntouched(original: String) async throws {
        _ = NSApplication.shared
        defer { scratch.removePersistentDomain(forName: Self.scratchSuite) }
        let document = DocumentBox(original)
        let storage = RectoTextStorage(documentId: "presentation-switch", markdown: original)
        var mutations = 0
        storage.onEdit = { _ in mutations += 1 }
        let (host, window) = mount(document, storage: storage, isEditable: true, defaults: scratch)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        #expect(markerIsHidden(in: textView))

        // Typing first gives the switch a history to lose.
        textView.insertText("!", replacementRange: NSRange(location: (original as NSString).length, length: 0))
        await drainMainQueue()
        let edited = original + "!"
        let undoManager = try #require(storage.controller.undoManager)
        #expect(undoManager.canUndo)
        #expect(mutations == 1)
        #expect(document.writes == 1)
        let selection = (edited as NSString).range(of: "quote")
        textView.setSelectedRange(selection)

        press(.raw, in: window)
        await drainMainQueue()
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(scratch.string(forKey: PresentationPreference.key) == Presentation.raw.rawValue)
        #expect(textView.isEditable)
        #expect(!markerIsHidden(in: textView), "raw must show the heading marker")
        #expect(!textView.isAutomaticQuoteSubstitutionEnabled)
        #expect(!textView.smartInsertDeleteEnabled)
        #expect(!textView.isAutomaticTextReplacementEnabled)
        expectUntouched(document, storage: storage, textView: textView, expected: edited)
        #expect(textView.selectedRange() == selection)

        press(.rich, in: window)
        await drainMainQueue()
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(scratch.string(forKey: PresentationPreference.key) == Presentation.rich.rawValue)
        #expect(textView.isEditable)
        #expect(markerIsHidden(in: textView), "rich must hide the heading marker again")
        #expect(textView.isAutomaticQuoteSubstitutionEnabled)
        #expect(textView.smartInsertDeleteEnabled)
        expectUntouched(document, storage: storage, textView: textView, expected: edited)
        #expect(textView.selectedRange() == selection)
        #expect(mutations == 1)
        #expect(document.writes == 1)

        #expect(undoManager.canUndo, "the switch must not drop the undo history")
        undoManager.undo()
        #expect(Array(textView.string.utf16) == Array(original.utf16))
        #expect(Array(document.value.markdown.utf16) == Array(original.utf16))
        #expect(undoManager.canRedo)
    }

    @Test("each window keeps its own lens; the last choice is what a new window opens in")
    func windowsSwitchIndependently() async throws {
        _ = NSApplication.shared
        defer { scratch.removePersistentDomain(forName: Self.scratchSuite) }
        let source = "# Two windows\n\nBody.\n"
        let first = RectoTextStorage(documentId: "window-1", markdown: source)
        let second = RectoTextStorage(documentId: "window-2", markdown: source)
        let (firstHost, firstWindow) = mount(DocumentBox(source), storage: first, isEditable: true, defaults: scratch)
        defer { firstWindow.close() }
        let (secondHost, secondWindow) = mount(DocumentBox(source), storage: second, isEditable: true, defaults: scratch)
        defer { secondWindow.close() }
        firstHost.layoutSubtreeIfNeeded()
        secondHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let firstText = try #require(first.textView.nsTextView)
        let secondText = try #require(second.textView.nsTextView)
        #expect(markerIsHidden(in: firstText))
        #expect(markerIsHidden(in: secondText))

        #expect(firstWindow.makeFirstResponder(firstText))
        press(.raw, in: firstWindow)
        await drainMainQueue()
        firstHost.layoutSubtreeIfNeeded()
        secondHost.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(!markerIsHidden(in: firstText), "the window that chose raw shows the source")
        #expect(markerIsHidden(in: secondText), "the other window keeps its lens")
        #expect(scratch.string(forKey: PresentationPreference.key) == Presentation.raw.rawValue)

        let third = RectoTextStorage(documentId: "window-3", markdown: source)
        let (thirdHost, thirdWindow) = mount(DocumentBox(source), storage: third, isEditable: true, defaults: scratch)
        defer { thirdWindow.close() }
        thirdHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let thirdText = try #require(third.textView.nsTextView)
        #expect(!markerIsHidden(in: thirdText), "a new window opens in the last chosen lens")
        #expect(markerIsHidden(in: secondText), "opening a window changes nothing elsewhere")
    }

    /// The mode chords from the web keymap: ⌃⇧M for raw, ⌃⇧R for rich,
    /// delivered the way AppKit delivers them to the key window.
    private func press(_ presentation: Presentation, in window: NSWindow) {
        let (key, code): (String, UInt16) = presentation == .raw ? ("m", 46) : ("r", 15)
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [.control, .shift],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: code
        )!
        #expect(window.performKeyEquivalent(with: event), "⌃⇧\(key.uppercased()) was not handled")
    }

    private func mount(
        _ document: DocumentBox,
        storage: RectoTextStorage,
        isEditable: Bool,
        defaults: UserDefaults
    ) -> (NSHostingView<some View>, NSWindow) {
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(
                get: { document.value },
                set: {
                    document.writes += 1
                    document.value = $0
                }
            ),
            isEditable: isEditable,
            storage: storage
        ).defaultAppStorage(defaults))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        return (host, window)
    }

    /// Rich and preview collapse the leading `#` to a sub-point font; raw
    /// leaves it at body size.
    private func markerIsHidden(in textView: NSTextView) -> Bool {
        let font = textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        return (font?.pointSize ?? .infinity) < 1
    }

    private func expectUntouched(
        _ document: DocumentBox,
        storage: RectoTextStorage,
        textView: NSTextView,
        expected: String
    ) {
        #expect(Array(storage.markdown.utf8) == Array(expected.utf8))
        #expect(Array(textView.string.utf16) == Array(expected.utf16))
        #expect(Array(document.value.markdown.utf8) == Array(expected.utf8))
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
