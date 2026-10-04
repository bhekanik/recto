import AppKit
import RectoEditor
@testable import RectoStore
import SwiftUI
import Testing
@testable import Recto

@Suite("Overflow panel", .serialized)
@MainActor
struct OverflowPanelTests {
    private func makeModel() async throws -> (RectoStore, OverflowModel) {
        let store = try RectoStore.inMemory()
        try await store.save(DocumentRecord(localId: "overflow", title: "Draft", markdown: "Prose", wordCount: 1, localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))
        return (store, try OverflowModel.open(store: store, localId: "overflow"))
    }

    @Test("all panes share an owner and storage refusal keeps a visibly unsaved buffer")
    func sharedAndRefused() async throws {
        let (store, model) = try await makeModel()
        #expect(try OverflowModel.open(store: store, localId: "overflow") === model)
        #expect(model.accept("saved"))
        let rejected = String(repeating: "é", count: 32_769)
        #expect(!model.accept(rejected))
        #expect(model.displayMarkdown == rejected)
        #expect(model.unsavedMarkdown != nil)
        #expect(model.errorMessage != nil)
        #expect(try store.overflow(localId: "overflow").markdown == "saved")
        #expect(model.accept("repaired"))
        #expect(model.unsavedMarkdown == nil)
        #expect(try store.overflow(localId: "overflow").markdown == "repaired")
    }

    @Test("a SQLite write refusal keeps the last saved notes and the complete unsaved edit")
    func databaseRefusal() async throws {
        let (store, model) = try await makeModel()
        #expect(model.accept("last saved"))
        try await store.writer.writeWithoutTransaction { db in try db.execute(sql: "PRAGMA query_only = ON") }
        #expect(!model.accept("unsaved notes"))
        #expect(model.displayMarkdown == "unsaved notes")
        #expect(model.record.markdown == "last saved")
        #expect(try store.overflow(localId: "overflow").markdown == "last saved")
        try await store.writer.writeWithoutTransaction { db in try db.execute(sql: "PRAGMA query_only = OFF") }
        model.retryUnsaved()
        #expect(model.unsavedMarkdown == nil)
        #expect(try store.overflow(localId: "overflow").markdown == "unsaved notes")
    }

    @Test("stale pane input cannot replace accepted notes")
    func stalePane() async throws {
        let (_, model) = try await makeModel()
        #expect(model.accept("newer", expectedGeneration: 0))
        #expect(!model.accept("stale", expectedGeneration: 0))
        #expect(model.record.markdown == "newer")
        #expect(model.unsavedMarkdown == "stale")
    }

    @Test("focused scratchpad undo uses its own history; normal copy back edits prose")
    func focusedUndoAndCopyBack() async throws {
        _ = NSApplication.shared
        let (store, model) = try await makeModel()
        let suite = "com.bhekani.recto.tests.overflow.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let chrome = EditorHostController(settings: StudioSettings(defaults: defaults, systemAppearance: { .dark }))
        var proseUndos = 0
        chrome.undo = { proseUndos += 1 }
        let storage = RectoTextStorage(documentId: "overflow-prose", markdown: "Prose")
        let host = NSHostingView(rootView: HStack {
            RectoEditorView(storage: storage, styler: MarkdownStyler(presentation: .raw, theme: .twilight), onAttach: chrome.attach)
            OverflowPanel(model: model, theme: .twilight, close: {}, onFocus: chrome.noteOverflowFocused)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { chrome.attach(nil); window.close() }
        host.layoutSubtreeIfNeeded()
        await Task.yield()
        let scratchpad = try #require(findOverflow(in: host))
        #expect(window.makeFirstResponder(scratchpad))
        scratchpad.insertText("Unused passage", replacementRange: NSRange(location: 0, length: 0))
        scratchpad.breakUndoCoalescing()
        #expect(model.record.markdown == "Unused passage")
        #expect(UndoRedoCommands.perform(.undo, keyWindow: window, editors: .shared))
        #expect(scratchpad.string == "", "scratchpad after undo: \(scratchpad.string), generation \(model.record.generation), unsaved \(model.unsavedMarkdown ?? "none")")
        #expect(model.record.markdown == "", "saved after undo: \(model.record.markdown)")
        #expect(proseUndos == 0)
        chrome.formatToolbarActions.redo()
        #expect(model.record.markdown == "Unused passage")
        #expect(try await store.document(localId: "overflow")?.localHeadNodeId == "root")
        #expect(storage.markdown == "Prose")
        let proseView = try #require(chrome.seam?.nsTextView)
        #expect(window.makeFirstResponder(proseView))
        proseView.insertText(model.record.markdown, replacementRange: NSRange(location: 0, length: 0))
        #expect(storage.markdown.contains("Unused passage"))
        #expect(model.record.markdown == "Unused passage")
    }

    private func findOverflow(in view: NSView) -> OverflowTextView? {
        if let text = view as? OverflowTextView { return text }
        return view.subviews.lazy.compactMap { findOverflow(in: $0) }.first
    }
}
