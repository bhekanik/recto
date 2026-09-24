import AppKit
@testable import RectoAuth
import RectoCore
import RectoEditor
import RectoStore
import RectoSync
import SwiftUI
import Testing
@testable import Recto

/// Renders the synced library with sample documents, dark and light, for
/// visual review. Runs only when `RECTO_SNAPSHOT_DIR` is set; the harness
/// writes `<name>.req` there with the window number, and a shell loop outside
/// the test captures it (screencapture needs the terminal's screen-recording
/// permission, not the test host's) and answers with `<name>.done`.
/// `apple/scripts/snapshot-library.sh` does both halves.
@Suite("Snapshot harness", .serialized)
@MainActor
struct SnapshotHarness {
    private actor Transport: RectoTransport {
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
        func appendNode(documentId: String, node: CommitEditRequest) async throws { throw Failure.unexpectedCall }
        func rename(documentId: String, title: String) async throws { throw Failure.unexpectedCall }
        func remove(documentId: String) async throws { throw Failure.unexpectedCall }
        func recordWritingStat(date: String, words: Int) async throws { throw Failure.unexpectedCall }
        func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] { [] }
        func getDocument(documentId: String) async throws -> RemoteDocument? { nil }
        func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
            AsyncThrowingStream { $0.finish() }
        }
        func nodesStream(documentId: String, sinceCreatedAt: Double?)
            -> AsyncThrowingStream<[RemoteNode], any Error> { AsyncThrowingStream { $0.finish() } }
        func loginFromCache() async -> Bool { false }
    }

    private static var dir: String? {
        ProcessInfo.processInfo.environment["RECTO_SNAPSHOT_DIR"].flatMap { $0.isEmpty ? nil : $0 }
    }

    private static let essay = """
    # The second draft is where the work happens

    The first draft is for you. You get the idea out of your head and onto the page, and you forgive every clumsy sentence because the point was to *find* the thing, not to polish it.

    The second draft is for the reader. You read the thing as a stranger would, and you cut everything that only made sense to you.

    ## What changes between drafts

    - The opening moves closer to the point
    - Paragraphs get **one job each**
    - Examples replace adjectives

    > Write drunk, edit sober — the line is misattributed, but the advice holds.

    When I started writing a newsletter I kept the first draft and fixed typos. Readers could tell. The pieces that landed were the ones I rewrote from the top, with the first draft open in another window as a quarry rather than a foundation.

    ### A small checklist

    1. Read it out loud
    2. Delete the first paragraph
    3. Check every `code` sample runs

    The rest is patience.
    """

    private static let others = [
        "Notes on quiet software", "Weekly letter — 38", "Why I stopped using folders",
        "Draft: the cost of a feature", "Reading list, September",
    ]

    @Test("library snapshots")
    func library() async throws {
        guard let dir = Self.dir else { return }
        _ = NSApplication.shared
        let essay = Self.essay, others = Self.others

        let store = try RectoStore.inMemory()
        let origin = try await SyncEngine.resolveOrigin(store: store)
        let sync = SyncEngine(store: store, transport: Transport(), origin: origin)
        let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
        let library = DocumentLibrary(store: store, sync: sync, origin: origin)
        let auth = RectoAuth(store: store)
        auth.attach(sync: sync)
        auth.attach(sessions: registry)
        let model = RectoApplicationModel(components: .init(
            store: store, auth: auth, sync: sync, registry: registry, library: library))
        await model.start()
        auth.convexAuthProvider.activeSessionID = { "session-snap" }
        auth.convexAuthProvider.cachedLogin = { true }
        await auth.restoreSessionForTesting(userId: "snap")
        await sync.stop()

        let settings = StudioSettings.shared
        let root = NSHostingView(rootView: StudioAppearanceForSnapshots(settings: settings) {
            RectoCloudRootView(model: model)
        })
        let window = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.contentView = root
        window.makeKeyAndOrderFront(nil)

        var previous: NSTextView?
        for (index, title) in (others + ["essay"]).enumerated() {
            await model.createDocument()
            let text = title == "essay" ? essay : "# \(title)\n\nA few lines of notes for document \(index + 1).\n"
            let textView = try await waitForEditor(in: window, notSameAs: previous)
            previous = textView
            window.makeFirstResponder(textView)
            textView.insertText(text, replacementRange: NSRange(location: 0, length: 0))
            try await Task.sleep(for: .milliseconds(400))
        }
        let textView = try await waitForEditor(in: window)
        window.makeFirstResponder(textView)
        textView.setSelectedRange(NSRange(location: 60, length: 0))
        textView.scrollRangeToVisible(NSRange(location: 0, length: 0))
        textView.enclosingScrollView?.contentView.scroll(to: .zero)

        for appearance in [StudioSettings.Appearance.dark, .light] {
            settings.appearance = appearance
            try await Task.sleep(for: .milliseconds(900))
            try await capture(window, name: "library-\(appearance.rawValue)", in: dir)
        }
        settings.appearance = .system
        window.orderOut(nil)
    }

    private func waitForEditor(in window: NSWindow, notSameAs previous: NSTextView? = nil) async throws -> NSTextView {
        for _ in 0..<400 {
            if let view = EditorHostRegistry.shared.controller(in: window)?.seam?.nsTextView,
               view !== previous, view.window != nil { return view }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("the editor never mounted")
        throw CancellationError()
    }

    private func capture(_ window: NSWindow, name: String, in dir: String) async throws {
        let request = "\(dir)/\(name).req", done = "\(dir)/\(name).done"
        try? FileManager.default.removeItem(atPath: done)
        try "\(window.windowNumber)".write(toFile: request, atomically: true, encoding: .utf8)
        for _ in 0..<1_000 where !FileManager.default.fileExists(atPath: done) {
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

private struct StudioAppearanceForSnapshots<Content: View>: View {
    let settings: StudioSettings
    @ViewBuilder let content: () -> Content
    var body: some View {
        content().preferredColorScheme(settings.preferredColorScheme)
    }
}
