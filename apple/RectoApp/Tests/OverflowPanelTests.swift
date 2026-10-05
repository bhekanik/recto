import AppKit
import RectoCore
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

    @Test("dragged Overflow selection enters at the drop caret through native ingress", arguments: [Presentation.rich, .raw, .vim, .preview])
    func dragSelection(presentation: Presentation) async throws {
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "drag-test")
        let document = try await library.createDocument(title: "Drag check")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "drag-test")
        let cloud = try await CloudDocumentModel.open(localId: document.localId, registry: registry)
        let model = try OverflowModel.open(store: store, localId: document.localId)
        let notes = "A spare 👩🏽‍💻 paragraph.\n"
        #expect(model.accept(notes))
        let storage = cloud.storage
        storage.markdown = "First 😀 line.\nLast line."
        cloud.accept(RectoEditorEdit(markdown: storage.markdown, structural: true))
        await cloud.save()
        var seam: RectoTextView?
        var edits: [RectoEditorEdit] = []
        let host = NSHostingView(rootView: HStack {
            RectoEditorView(storage: storage, styler: MarkdownStyler(presentation: presentation, theme: .twilight), onAttach: { seam = $0 }, onEdit: { edits.append($0); cloud.accept($0, from: storage) })
            OverflowPanel(model: model, theme: .twilight, close: {}, onFocus: {}, onDragBegan: { source, text in cloud.beginOverflowDrag(from: source, text: text) }, onDragEnded: cloud.endOverflowDrag)
        })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await Task.yield()
        let prose = try #require(seam?.nsTextView)
        let vim = RectoVimController()
        defer { vim.attach(to: nil) }
        let overflow = try #require(findOverflow(in: host))
        var offset = ("First 😀 line.\n" as NSString).length
        if presentation.isEditable {
            prose.insertText("!", replacementRange: NSRange(location: offset, length: 0))
            offset += 1
        }
        let before = storage.markdown
        edits.removeAll()
        prose.setSelectedRange(NSRange(location: offset, length: 0))
        let caret = try #require(seam?.caretRect())
        // Drop somewhere other than the old selection, using TextKit 2's caret geometry.
        prose.setSelectedRange(NSRange(location: 0, length: 0))
        let location = prose.convert(NSPoint(x: caret.minX + 1, y: caret.midY), to: nil)
        overflow.setSelectedRange(NSRange(location: 0, length: (notes as NSString).length))
        if presentation == .vim {
            vim.attach(to: seam)
            #expect(vim.status?.mode == "normal")
        }
        overflow.onDragBegan(overflow, notes)
        let drag = OverflowTestDragInfo(source: overflow, window: window, location: location, text: notes)
        let operation = prose.draggingEntered(drag)
        _ = prose.draggingUpdated(drag)
        if !presentation.isEditable {
            #expect(operation.isEmpty)
            #expect(!prose.performDragOperation(drag))
            #expect(storage.markdown == before)
            #expect(model.record.markdown == notes)
            overflow.onDragEnded()
            await cloud.close()
            return
        }
        #expect(operation == .copy)
        #expect(prose.prepareForDragOperation(drag))
        #expect(prose.performDragOperation(drag))
        prose.concludeDragOperation(drag)
        #expect(storage.markdown == (before as NSString).replacingCharacters(in: NSRange(location: offset, length: 0), with: notes))
        #expect(edits.count == 1)
        #expect(model.record.markdown == notes)
        overflow.onDragEnded()
        if presentation == .vim {
            #expect(vim.status?.mode == "visual", "AppKit selects the inserted passage and Vim follows that selection")
        }
        vim.attach(to: nil)
        let dropped = storage.markdown
        prose.insertText("x", replacementRange: NSRange(location: offset + (notes as NSString).length, length: 0))
        await cloud.undo()
        #expect(storage.markdown == dropped, "Undo removes subsequent typing without merging it into the drop")
        await cloud.undo()
        #expect(storage.markdown == before, "One Undo removes just the drop and keeps earlier adjacent typing")
        #expect(model.record.markdown == notes)
        await cloud.redo()
        #expect(storage.markdown == dropped)
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == dropped)
        #expect(try await store.pendingJobs(documentLocalId: document.localId).contains { $0.kind == .commitEdit })
        await cloud.close()
    }

    @Test("drag classification requires one complete exact insertion, including repeated Unicode")
    func exactInsertion() {
        #expect(CloudDocumentModel.isOverflowInsertion(before: "abc", after: "abaabc", dragged: "aba"))
        #expect(CloudDocumentModel.isOverflowInsertion(before: "😀é", after: "😀👩🏽‍💻é", dragged: "👩🏽‍💻"))
        #expect(CloudDocumentModel.isOverflowInsertion(before: "", after: "note", dragged: "note"))
        #expect(CloudDocumentModel.isOverflowInsertion(before: "a\r\nb", after: "a\r\nnote\r\nb", dragged: "note\r\n"))
        #expect(!CloudDocumentModel.isOverflowInsertion(before: "abc", after: "axc", dragged: "x"))
        #expect(!CloudDocumentModel.isOverflowInsertion(before: "abc", after: "noteabc!", dragged: "note"))
        #expect(!CloudDocumentModel.isOverflowInsertion(before: "abc", after: "abc", dragged: ""))
        #expect(!CloudDocumentModel.isOverflowInsertion(before: "é", after: "ée\u{301}", dragged: "é"))
    }

    private func findOverflow(in view: NSView) -> OverflowTextView? {
        if let text = view as? OverflowTextView { return text }
        return view.subviews.lazy.compactMap { findOverflow(in: $0) }.first
    }
}

@MainActor
private final class OverflowTestDragInfo: NSObject, NSDraggingInfo {
    let draggingPasteboard = NSPasteboard.withUniqueName()
    let draggingDestinationWindow: NSWindow?
    let draggingSource: Any?
    let draggingLocation: NSPoint
    let draggingSourceOperationMask: NSDragOperation = [.copy, .generic]
    let draggingSequenceNumber = 1
    nonisolated var draggedImage: NSImage? { nil }
    var draggedImageLocation: NSPoint { draggingLocation }
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight = .none
    init(source: NSTextView, window: NSWindow, location: NSPoint, text: String) {
        draggingSource = source
        draggingDestinationWindow = window
        draggingLocation = location
        super.init()
        draggingPasteboard.setString(text, forType: .string)
    }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    func resetSpringLoading() {}
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions, for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
}
