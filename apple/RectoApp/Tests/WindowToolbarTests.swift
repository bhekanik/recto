import AppKit
import RectoAuth
import RectoCore
import RectoEditor
import RectoStore
import RectoSync
import SwiftUI
import Testing
@testable import Recto

/// The window toolbars no longer carry undo/redo — TopFormatToolbar owns the
/// buttons (web parity) and the Edit menu owns the chords, dispatched to the
/// key window's host history the way the mode chords dispatch.
@Suite("Undo in the window chrome", .serialized)
@MainActor
struct WindowToolbarTests {
    private actor ToolbarTransport: RectoTransport {
        enum Failure: Error { case unexpectedCall }
        func createDocument(title: String, documentUuid: String) async throws
            -> CreateDocumentResponse { throw Failure.unexpectedCall }
        func commitEdit(_ request: CommitEditRequest) async throws
            -> CommitEditResponse { throw Failure.unexpectedCall }
        func updateCurrentNodeId(
            documentId: String, currentNodeId: String, markdown: String, wordCount: Int,
            updatedAt: Double, expectedPointerRevision: Double?, title: String?
        ) async throws -> UpdateCurrentNodeResponse { throw Failure.unexpectedCall }
        func updateMarkdown(
            documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double,
            expectedHeadNodeId: String?, title: String?
        ) async throws -> UpdateMarkdownResponse { throw Failure.unexpectedCall }
        func appendNode(documentId: String, node: CommitEditRequest) async throws {
            throw Failure.unexpectedCall
        }
        func rename(documentId: String, title: String) async throws { throw Failure.unexpectedCall }
        func remove(documentId: String) async throws { throw Failure.unexpectedCall }
        func recordWritingStat(date: String, words: Int) async throws { throw Failure.unexpectedCall }
        func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] { [] }
        func getDocument(documentId: String) async throws -> RemoteDocument? { nil }
        func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
            AsyncThrowingStream { $0.finish() }
        }
        func nodesStream(documentId: String, sinceCreatedAt: Double?)
            -> AsyncThrowingStream<[RemoteNode], any Error> {
            AsyncThrowingStream { $0.finish() }
        }
        func loginFromCache() async -> Bool { false }
    }

    private final class DocumentBox {
        var value: RectoDocument
        init(_ markdown: String) { value = RectoDocument(markdown: markdown) }
    }

    private static let scratchSuite = "com.bhekani.recto.tests.window-toolbar"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    // MARK: - Menu dispatch

    @Test("the Edit menu's undo dispatches to a file host's history")
    func menuUndoDispatchesInFileHost() async throws {
        _ = NSApplication.shared
        let (host, window, document, storage) = mountFileHost("abc\n")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await settle()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))

        textView.setSelectedRange(NSRange(location: 0, length: 0))
        textView.insertText("X", replacementRange: NSRange(location: 0, length: 0))

        let handled = UndoRedoCommands.perform(.undo, keyWindow: window, editors: .shared)
        #expect(handled, "a window with a host dispatches to its history")
        #expect(document.value.markdown == "abc\n", "the typed edit came back out")

        UndoRedoCommands.perform(.redo, keyWindow: window, editors: .shared)
        #expect(document.value.markdown == "Xabc\n", "redo replays it")
    }

    @Test("the Edit menu's undo dispatches to a cloud host's session")
    func menuUndoDispatchesInCloudHost() async throws {
        _ = NSApplication.shared
        let components = try await makeCloudComponents()
        let document = try await components.library.createDocument(title: "Menu undo")
        let host = NSHostingView(rootView: CloudDocumentView(
            localId: document.localId,
            registry: components.registry,
            settings: scratchSettings()
        ).defaultAppStorage(scratch))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()

        // The view opens its model asynchronously; the host's chrome registers
        // with the shared registry once the editor is on screen.
        #expect(await waitUntil { EditorHostRegistry.shared.controller(in: window) != nil },
                "the cloud document mounted")
        let chrome = try #require(EditorHostRegistry.shared.controller(in: window))
        let textView = try #require(chrome.seam?.nsTextView)
        #expect(window.makeFirstResponder(textView))

        let original = chrome.markdown
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        textView.insertText("X", replacementRange: NSRange(location: 0, length: 0))
        #expect(chrome.markdown != original, "the keystroke landed")

        let handled = UndoRedoCommands.perform(.undo, keyWindow: window, editors: .shared)
        #expect(handled, "the cloud window dispatches to its session history")
        let reverted = await waitUntil { chrome.markdown == original }
        #expect(reverted, "undo navigated the session back to \(original ?? ""), got \(chrome.markdown ?? "")")
    }

    @Test("a window with no editor host falls back to the responder chain")
    func menuUndoFallsThroughToTheResponderChain() async throws {
        _ = NSApplication.shared
        let window = NSWindow(contentViewController: NSViewController())
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        let handled = UndoRedoCommands.perform(.undo, keyWindow: window, editors: .shared)
        #expect(!handled, "no host means the standard chain owns the key")
        // The selector the standard item would have sent, unchanged.
        #expect(UndoRedoCommands.undoSelector == #selector(UndoManager.undo))
        #expect(UndoRedoCommands.redoSelector == #selector(UndoManager.redo))
    }

    // MARK: - Window chord ownership

    @Test("⌘Z belongs to the menu, not to an in-window toolbar button")
    func commandZIsNotAnInWindowButton() async throws {
        _ = NSApplication.shared
        let (host, window, _, storage) = mountFileHost("abc\n")
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await settle()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))

        // Positive control: the harness sees in-window SwiftUI keyboard
        // shortcuts, so the negative assertions below can see them too.
        #expect(window.performKeyEquivalent(with: Self.event("v", [.control, .shift])),
                "the status bar's mode chord is still answered in-window")

        #expect(!window.performKeyEquivalent(with: Self.event("z", [.command])),
                "the old toolbar button no longer answers ⌘Z")
        #expect(!window.performKeyEquivalent(with: Self.event("z", [.command, .shift])),
                "the old toolbar button no longer answers ⇧⌘Z")

        // The menu's dispatch owns the chords instead.
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        textView.insertText("X", replacementRange: NSRange(location: 0, length: 0))
        #expect(UndoRedoCommands.perform(.undo, keyWindow: window, editors: .shared))
        #expect(UndoRedoCommands.perform(.redo, keyWindow: window, editors: .shared))
    }

    private static func event(
        _ characters: String, _ modifiers: NSEvent.ModifierFlags
    ) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: 0, context: nil,
            characters: characters, charactersIgnoringModifiers: characters,
            isARepeat: false, keyCode: 0)!
    }

    // MARK: - Harness

    private func scratchSettings() -> StudioSettings {
        StudioSettings(defaults: scratch, systemAppearance: { .dark })
    }

    private func makeCloudComponents() async throws -> RectoApplicationModel.Components {
        let store = try RectoStore.inMemory()
        let origin = try await SyncEngine.resolveOrigin(store: store)
        let sync = SyncEngine(store: store, transport: ToolbarTransport(), origin: origin)
        let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
        let library = DocumentLibrary(store: store, sync: sync, origin: origin)
        let auth = RectoAuth(store: store)
        auth.attach(sync: sync)
        auth.attach(sessions: registry)
        return .init(store: store, auth: auth, sync: sync, registry: registry, library: library)
    }

    private func mountFileHost(_ markdown: String)
        -> (NSHostingView<some View>, NSWindow, DocumentBox, RectoTextStorage) {
        let box = DocumentBox(markdown)
        let storage = RectoTextStorage(documentId: "toolbar-undo", markdown: markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { box.value }, set: { box.value = $0 }),
            isEditable: true,
            storage: storage,
            settings: scratchSettings()
        ).defaultAppStorage(scratch))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        return (host, window, box, storage)
    }

    private func settle() async {
        await drainMainQueue()
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    /// Poll on the main actor until the condition holds (or the deadline does).
    private func waitUntil(
        _ condition: @MainActor () -> Bool,
        timeout: TimeInterval = 3
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(10))
            await drainMainQueue()
        }
        return condition()
    }
}
