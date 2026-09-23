import AppKit
import MarkdownEngine
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

/// Vim as a lens in the mode ring: choosing it installs the key layer in that
/// window and nowhere else, leaving it takes the layer down, and the footer
/// shows the mode line only while it is the active lens.
@Suite("Vim in the mode ring", .serialized)
@MainActor
struct VimPresentationHostTests {
    private final class DocumentBox {
        var value: RectoDocument
        init(_ markdown: String) { value = RectoDocument(markdown: markdown) }
    }

    private static let scratchSuite = "com.bhekani.recto.tests.vim-ring"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    @Test("choosing Vim installs the key layer in that window only")
    func vimIsPerWindow() async throws {
        _ = NSApplication.shared
        defer { scratch.removePersistentDomain(forName: Self.scratchSuite) }
        let source = "the quick brown fox\n"
        let first = RectoTextStorage(documentId: "vim-1", markdown: source)
        let second = RectoTextStorage(documentId: "vim-2", markdown: source)
        let (firstHost, firstWindow) = mount(DocumentBox(source), storage: first)
        defer { firstWindow.close() }
        let (secondHost, secondWindow) = mount(DocumentBox(source), storage: second)
        defer { secondWindow.close() }
        firstHost.layoutSubtreeIfNeeded()
        secondHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let firstText = try #require(first.textView.nsTextView)
        #expect(first.controller.keyInterceptor == nil)
        #expect(second.controller.keyInterceptor == nil)

        #expect(firstWindow.makeFirstResponder(firstText))
        press(.vim, in: firstWindow)
        await settle(firstHost, secondHost)

        let vim = try #require(first.controller.keyInterceptor as? RectoVimController)
        #expect(vim.isAttached)
        #expect(vim.status?.mode == "normal")
        #expect(first.textView.caretShape == .block)
        #expect(second.controller.keyInterceptor == nil, "the other window keeps its lens")
        #expect(second.textView.caretShape == .bar)
        #expect(scratch.string(forKey: PresentationPreference.key) == Presentation.vim.rawValue)

        // Keys now go to vim in this window: `dw` deletes a word, no text is typed.
        firstText.setSelectedRange(NSRange(location: 0, length: 0))
        for key in ["d", "w"] { firstText.keyDown(with: Self.key(key)) }
        #expect(first.markdown == "quick brown fox\n")
        #expect(second.markdown == source)

        // A new window opens in the last chosen lens.
        let third = RectoTextStorage(documentId: "vim-3", markdown: source)
        let (thirdHost, thirdWindow) = mount(DocumentBox(source), storage: third)
        defer { thirdWindow.close() }
        thirdHost.layoutSubtreeIfNeeded()
        await drainMainQueue()
        #expect(third.controller.keyInterceptor is RectoVimController)
    }

    @Test("leaving Vim takes the key layer down and keeps the selection")
    func leavingVimDetaches() async throws {
        _ = NSApplication.shared
        defer { scratch.removePersistentDomain(forName: Self.scratchSuite) }
        let source = "# Title\n\nBody with a quote here.\n"
        let storage = RectoTextStorage(documentId: "vim-leave", markdown: source)
        let (host, window) = mount(DocumentBox(source), storage: storage)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        let selection = (source as NSString).range(of: "quote")
        textView.setSelectedRange(selection)

        press(.vim, in: window)
        await settle(host)
        let vim = try #require(storage.controller.keyInterceptor as? RectoVimController)
        #expect(textView.selectedRange() == selection, "the switch into vim carries the selection")
        #expect(vim.status != nil)

        press(.rich, in: window)
        await settle(host)

        #expect(storage.controller.keyInterceptor == nil)
        #expect(!vim.isAttached)
        #expect(vim.status == nil)
        #expect(storage.textView.caretShape == .bar)
        #expect(textView.selectedRange() == selection, "the switch out of vim carries the selection")
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        textView.keyDown(with: Self.key("x"))
        #expect(storage.markdown == "x" + source, "with vim gone, x is a letter again")
    }

    @Test("the footer shows the vim mode line only for the vim lens")
    func statusBarShowsVimOnlyInVim() {
        let wordCount = DocumentWordCount()
        let settings = StudioSettings(defaults: scratch, systemAppearance: { .dark })
        let vim = RectoVimController()
        for presentation in Presentation.allCases {
            let bar = EditorStatusBar(
                presentation: presentation, isEditable: true, wordCount: wordCount, settings: settings,
                theme: .twilight, vimController: vim, onSelect: { _ in })
            #expect(bar.showsVimStatus == (presentation == .vim), "\(presentation)")
        }
        let bare = EditorStatusBar(
            presentation: .vim, isEditable: true, wordCount: wordCount, settings: settings,
            theme: .twilight, onSelect: { _ in })
        #expect(!bare.showsVimStatus, "a host without a vim layer shows nothing")
    }

    // MARK: - Helpers

    private static func key(_ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0,
            context: nil, characters: characters, charactersIgnoringModifiers: characters,
            isARepeat: false, keyCode: 0)!
    }

    /// The mode chords from the web keymap (`lib/keyboard/actions.ts`): ⌃⇧V
    /// for vim, ⌃⇧R for rich.
    private func press(_ presentation: Presentation, in window: NSWindow) {
        let (key, code): (String, UInt16) = presentation == .vim ? ("v", 9) : ("r", 15)
        let event = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [.control, .shift],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: code
        )!
        #expect(window.performKeyEquivalent(with: event), "⌃⇧\(key.uppercased()) was not handled")
    }

    private func mount(_ document: DocumentBox, storage: RectoTextStorage) -> (NSHostingView<some View>, NSWindow) {
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document.value }, set: { document.value = $0 }),
            isEditable: true,
            storage: storage,
            settings: StudioSettings(defaults: scratch, systemAppearance: { .dark })
        ).defaultAppStorage(scratch))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        return (host, window)
    }

    private func settle(_ hosts: NSView...) async {
        await drainMainQueue()
        for host in hosts { host.layoutSubtreeIfNeeded() }
        await drainMainQueue()
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
