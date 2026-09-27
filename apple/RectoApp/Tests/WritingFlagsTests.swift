import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

/// ⌘⇧X, the note, the notes panel's Go to and Resolve, in a real editor.
@Suite("Writing flags", .serialized)
@MainActor
struct WritingFlagsTests {
    private static let scratchSuite = "com.bhekani.recto.tests.writing-flags"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    @Test("⌘⇧X drops a flag at the caret, opens its note and leaves the caret after it")
    func dropsFlagAtCaret() async throws {
        let mounted = try await mount("Born in  in 1920.")
        defer { mounted.close() }
        mounted.textView.setSelectedRange(NSRange(location: 8, length: 0))
        mounted.chrome.addFlag()
        #expect(mounted.textView.string == "Born in <!--flag--> in 1920.")
        #expect(mounted.storage.markdown == "Born in <!--flag--> in 1920.")
        #expect(mounted.textView.selectedRange() == NSRange(location: 19, length: 0))
        #expect(mounted.chrome.notePopover != nil, "the note field opens")
        mounted.chrome.notePopover?.close()
        #expect(mounted.chrome.notePopover == nil)
        #expect(mounted.textView.selectedRange() == NSRange(location: 19, length: 0), "back after the flag")
    }

    @Test("a flag that would begin a line is guarded, so it stays inline")
    func guardsLineStart() async throws {
        let mounted = try await mount("One.\nwas born.")
        defer { mounted.close() }
        mounted.textView.setSelectedRange(NSRange(location: 5, length: 0))
        mounted.chrome.addFlag()
        mounted.chrome.notePopover?.close()
        #expect(mounted.textView.string == "One.\n\u{2060}<!--flag-->was born.")
    }

    @Test("the note is written into the flag, the caret back after it")
    func writesNote() async throws {
        let mounted = try await mount("Born in <!--flag--> in 1920.")
        defer { mounted.close() }
        let flag = WritingFlag(from: 8, to: 19, tokenFrom: 8, note: "")
        mounted.chrome.setNote("the  town -- name", of: flag)
        #expect(mounted.textView.string == "Born in <!--flag: the town – name--> in 1920.")
        #expect(mounted.textView.selectedRange().location == 36)
    }

    @Test("resolving removes the flag and one of the spaces around it")
    func resolves() async throws {
        let mounted = try await mount("Born in <!--flag: town--> in 1920.")
        defer { mounted.close() }
        mounted.chrome.resolve(WritingFlag(from: 8, to: 25, tokenFrom: 8, note: "town"))
        #expect(mounted.textView.string == "Born in in 1920.")
    }

    @Test("stale offsets edit nothing")
    func staleOffsets() async throws {
        let mounted = try await mount("Born in <!--flag: town--> in 1920.")
        defer { mounted.close() }
        let stale = WritingFlag(from: 2, to: 19, tokenFrom: 2, note: "town")
        mounted.chrome.resolve(stale)
        mounted.chrome.setNote("x", of: stale)
        #expect(mounted.textView.string == "Born in <!--flag: town--> in 1920.")
    }

    @Test("preview takes no flags")
    func previewIsReadOnly() async throws {
        let mounted = try await mount("Born in  in 1920.", presentation: .preview)
        defer { mounted.close() }
        mounted.chrome.addFlag()
        #expect(mounted.storage.markdown == "Born in  in 1920.")
        #expect(mounted.chrome.notePopover == nil)
    }

    @Test("the text shows a flag glyph in place of the comment")
    func drawsGlyph() async throws {
        let mounted = try await mount("Born in <!--flag: town--> in 1920.")
        defer { mounted.close() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 0))
        await drainMainQueue()
        let storage = try #require(mounted.textView.textStorage)
        let glyph = storage.attribute(NSAttributedString.Key("MarkdownRenderedImage"), at: 8, effectiveRange: nil)
        #expect(glyph is NSImage)
        let hidden = storage.attribute(.foregroundColor, at: 20, effectiveRange: nil) as? NSColor
        #expect(hidden == .clear, "the note text is hidden until the caret goes inside")
    }

    @Test("a click lands on a flag's edge; the flag is found from either side")
    func flagTouching() {
        let markdown = "Born in \u{2060}<!--flag: town--> in 1920."
        let expected = WritingFlag(from: 8, to: 26, tokenFrom: 9, note: "town")
        #expect(EditorHostController.flag(touching: 9, in: markdown) == expected)
        #expect(EditorHostController.flag(touching: 26, in: markdown) == expected)
        #expect(EditorHostController.flag(touching: 3, in: markdown) == nil)
        #expect(EditorHostController.flag(touching: 15, in: markdown) == nil)
    }

    @Test("closing a pinned notes panel unpins it")
    func pinnedPanel() {
        let settings = StudioSettings(defaults: scratch, systemAppearance: { .dark })
        let notes = NotesPanelState()
        #expect(!settings.notesPinned, "unpinned by default")
        #expect(!notes.isVisible(settings))
        settings.toggleNotesPinned()
        #expect(notes.isVisible(settings), "pinned is open")
        notes.toggle(settings)
        #expect(!notes.isVisible(settings))
        #expect(!settings.notesPinned)
        notes.toggle(settings)
        #expect(notes.isVisible(settings))
    }

    @Test("the outline marks the heading above each flag")
    func flaggedHeadings() {
        let outline = [
            OutlineHeading(depth: 1, text: "One", offset: 10, index: 0),
            OutlineHeading(depth: 2, text: "Two", offset: 40, index: 1),
            OutlineHeading(depth: 1, text: "Three", offset: 80, index: 2),
        ]
        let flags = [5, 50, 60].map { WritingFlag(from: $0, to: $0 + 11, tokenFrom: $0, note: "") }
        #expect(FlaggedHeadings.indexes(outline, flags) == [1])
    }

    // MARK: - Harness

    private struct Mounted {
        let settings: StudioSettings
        let chrome: EditorHostController
        let storage: RectoTextStorage
        let textView: NSTextView
        let window: NSWindow

        @MainActor
        func close() {
            chrome.notePopover?.close()
            window.close()
        }
    }

    private struct Host: View {
        let settings: StudioSettings
        let chrome: EditorHostController
        let storage: RectoTextStorage
        let presentation: Presentation

        var body: some View {
            RectoEditorView(
                storage: storage,
                styler: settings.styler(presentation: presentation),
                onAttach: chrome.attach,
                writingController: chrome.writingController
            )
            .frame(width: 720, height: 400)
        }
    }

    private func mount(_ markdown: String, presentation: Presentation = .rich) async throws -> Mounted {
        _ = NSApplication.shared
        let settings = StudioSettings(defaults: scratch, systemAppearance: { .dark })
        let chrome = EditorHostController(settings: settings)
        chrome.currentPresentation = { presentation }
        let storage = RectoTextStorage(documentId: "flags-\(UUID().uuidString)", markdown: markdown)
        let host = NSHostingView(rootView: Host(
            settings: settings, chrome: chrome, storage: storage, presentation: presentation))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        window.makeFirstResponder(textView)
        return Mounted(settings: settings, chrome: chrome, storage: storage, textView: textView, window: window)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
