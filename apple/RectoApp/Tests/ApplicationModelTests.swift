import AppKit
import Foundation
import SwiftUI
import RectoCore
import RectoEditor
import RectoStore
import RectoSync
import Testing

@testable import Recto
@testable import RectoAuth

private actor TestTransport: RectoTransport {
    enum Failure: Error { case unexpectedCall }
    private(set) var documentStreamStarts = 0

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
        documentStreamStarts += 1
        return AsyncThrowingStream<[RemoteDocumentSummary], any Error> { $0.finish() }
    }
    func nodesStream(documentId: String, sinceCreatedAt: Double?)
        -> AsyncThrowingStream<[RemoteNode], any Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func loginFromCache() async -> Bool { false }

    func resetDocumentStreamStarts() { documentStreamStarts = 0 }
}

private actor SuspendedTransition: SyncControlling {
    private var stopWaiter: CheckedContinuation<Void, Never>?
    private var stopObservers: [CheckedContinuation<Void, Never>] = []
    private(set) var startCount = 0
    private var stopStarted = false

    func stop() async {
        stopStarted = true
        let observers = stopObservers
        stopObservers.removeAll()
        observers.forEach { $0.resume() }
        await withCheckedContinuation { stopWaiter = $0 }
    }

    func start() { startCount += 1 }

    func waitUntilStopStarts() async {
        guard !stopStarted else { return }
        await withCheckedContinuation { stopObservers.append($0) }
    }

    func releaseStop() {
        stopWaiter?.resume()
        stopWaiter = nil
    }
}

private actor AuthConsumerGate {
    private var isReleased = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isReleased else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        isReleased = true
        let suspended = waiters
        waiters.removeAll()
        suspended.forEach { $0.resume() }
    }
}

private actor DocumentOpenGate {
    private var isReached = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private var observers: [CheckedContinuation<Void, Never>] = []

    func pauseIgnoringCancellation() async {
        isReached = true
        let waiting = observers
        observers.removeAll()
        for observer in waiting { observer.resume() }
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilReached() async {
        guard !isReached else { return }
        await withCheckedContinuation { observers.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

@MainActor
private func makeComponents(
    transport: TestTransport = TestTransport(),
    beforeAuthConsumption: (@MainActor @Sendable () async -> Void)? = nil
) async throws -> RectoApplicationModel.Components {
    let store = try RectoStore.inMemory()
    let origin = try await SyncEngine.resolveOrigin(store: store)
    let sync = SyncEngine(store: store, transport: transport, origin: origin)
    let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
    let library = DocumentLibrary(store: store, sync: sync, origin: origin)
    let auth = RectoAuth(store: store)
    auth.attach(sync: sync)
    auth.attach(sessions: registry)
    return .init(
        store: store,
        auth: auth,
        sync: sync,
        registry: registry,
        library: library,
        beforeAuthConsumption: beforeAuthConsumption
    )
}

@MainActor
private func waitForAuthStatus(
    _ expected: AuthStatus,
    in model: RectoApplicationModel
) async {
    for _ in 0..<100 where model.authStatus != expected { await Task.yield() }
}

@Suite("application composition")
struct ApplicationModelTests {
    @MainActor
    private func signedInModel(
        transport: TestTransport
    ) async throws -> (RectoApplicationModel, RectoApplicationModel.Components) {
        let components = try await makeComponents(transport: transport)
        let model = RectoApplicationModel(components: components)
        await model.start()
        components.auth.convexAuthProvider.activeSessionID = { "session-A" }
        components.auth.convexAuthProvider.cachedLogin = { true }
        await components.auth.restoreSessionForTesting(userId: "user-A")
        await components.sync.stop()
        await transport.resetDocumentStreamStarts()
        return (model, components)
    }

    @MainActor
    @Test("startup publishes auth state and signed-in library creation")
    func startupAndLibraryRouting() async throws {
        let components = try await makeComponents()
        let model = RectoApplicationModel(components: components)

        await model.start()
        await waitForAuthStatus(.signedOut, in: model)
        await model.receiveAuthStatus(.signedIn(userId: "test-user"))
        await model.createDocument()

        #expect(model.startupState == .ready)
        #expect(model.authStatus == .signedIn(userId: "test-user"))
        #expect(model.documents.count == 1)
        #expect(model.selectedDocumentId == model.documents.first?.localId)
    }

    @MainActor
    @Test("the first auth transition is buffered before its consumer runs")
    func bufferedInitialAuthTransition() async throws {
        let gate = AuthConsumerGate()
        let components = try await makeComponents { await gate.wait() }
        let model = RectoApplicationModel(components: components)

        await model.start()

        #expect(components.auth.status == .signedOut)
        #expect(model.authStatus == .loading)
        await gate.release()
        await waitForAuthStatus(.signedOut, in: model)
        #expect(model.authStatus == .signedOut)
        #expect(
            RectoCloudRootView.route(startup: model.startupState, auth: model.authStatus)
                == .signedOut)
    }

    @MainActor
    @Test("foreground policy never starts sockets for an unauthenticated mirror")
    func foregroundPolicy() {
        #expect(RectoApplicationModel.foregroundSyncAction(for: .loading) == .stayStopped)
        #expect(RectoApplicationModel.foregroundSyncAction(for: .signedOut) == .stayStopped)
        #expect(
            RectoApplicationModel.foregroundSyncAction(
                for: .blockedByRetainedWork(owner: "A", count: 1)) == .stayStopped)
        #expect(
            RectoApplicationModel.foregroundSyncAction(for: .signedIn(userId: "A")) == .resume)
        #expect(
            RectoApplicationModel.foregroundSyncAction(
                for: .convexLoginRequired(userId: "A")) == .recoverThenResume)
    }

    @MainActor
    @Test("foreground cannot restart sockets inside a suspended sign-out")
    func foregroundStaysStoppedDuringSignOut() async throws {
        let transport = TestTransport()
        let (model, components) = try await signedInModel(transport: transport)
        let transition = SuspendedTransition()
        components.auth.attach(sync: transition)

        let signOut = Task { try await components.auth.signOut() }
        await transition.waitUntilStopStarts()
        #expect(components.auth.isTransitioning)
        await model.enterForeground()

        #expect(await transport.documentStreamStarts == 0)
        #expect(await transition.startCount == 0)
        await transition.releaseStop()
        try await signOut.value
        #expect(!components.auth.isTransitioning)
        #expect(await transport.documentStreamStarts == 0)
    }

    @MainActor
    @Test("foreground waits for an account switch before starting the new sockets")
    func foregroundStaysStoppedDuringAccountSwitch() async throws {
        let transport = TestTransport()
        let (model, components) = try await signedInModel(transport: transport)
        let transition = SuspendedTransition()
        components.auth.attach(sync: transition)
        components.auth.convexAuthProvider.activeSessionID = { "session-B" }

        let accountSwitch = Task {
            await components.auth.handleSessionSwitchForTesting(
                from: "user-A", toUserId: "user-B")
        }
        await transition.waitUntilStopStarts()
        #expect(components.auth.isTransitioning)
        await model.enterForeground()

        #expect(await transport.documentStreamStarts == 0)
        #expect(await transition.startCount == 0)
        await transition.releaseStop()
        await accountSwitch.value
        #expect(!components.auth.isTransitioning)
        #expect(await transition.startCount == 1)
        #expect(await transport.documentStreamStarts == 0)

        await model.enterForeground()
        for _ in 0..<100 where await transport.documentStreamStarts == 0 {
            await Task.yield()
        }
        #expect(await transport.documentStreamStarts == 1)
    }

    @MainActor
    @Test("root routing follows startup and auth state")
    func rootRouting() {
        #expect(RectoCloudRootView.route(startup: .idle, auth: .signedOut) == .opening)
        #expect(
            RectoCloudRootView.route(startup: .failed("bad config"), auth: .signedOut)
                == .startupFailure("bad config"))
        #expect(RectoCloudRootView.route(startup: .ready, auth: .signedOut) == .signedOut)
        #expect(
            RectoCloudRootView.route(startup: .ready, auth: .signedIn(userId: "A")) == .signedIn)
        #expect(
            RectoCloudRootView.route(
                startup: .ready, auth: .blockedByRetainedWork(owner: "A", count: 2))
                == .blocked(owner: "A", count: 2))
    }

    @MainActor
    @Test("one document has at most one editable full-snapshot ingress")
    func singletonEditableIngress() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Singleton")
        let first = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)

        await #expect(throws: SessionError.editableHolderExists(document.localId)) {
            _ = try await CloudDocumentModel.open(
                localId: document.localId, registry: components.registry)
        }

        await first.close()
        let reopened = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        #expect(reopened.isEditable)
        await reopened.close()
    }

    @MainActor
    @Test("a cancelled open releases its acquired session and ingress")
    func cancelledDocumentOpen() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Cancelled open")
        let gate = DocumentOpenGate()
        let opening = Task {
            try await CloudDocumentModel.open(
                localId: document.localId,
                registry: components.registry,
                afterIngressRegistered: { await gate.pauseIgnoringCancellation() }
            )
        }

        await gate.waitUntilReached()
        opening.cancel()
        await gate.release()
        await #expect(throws: CancellationError.self) {
            _ = try await opening.value
        }

        #expect(await components.registry.openDocumentIds.isEmpty)
        let reopened = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        await reopened.close()
    }

    @MainActor
    @Test("a replacement open waits for the outgoing editable owner")
    func replacementDocumentOpen() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Replacement open")
        let first = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        let retryGate = DocumentOpenGate()
        let replacement = Task {
            try await CloudDocumentModel.open(
                localId: document.localId,
                registry: components.registry,
                waitForEditableHolder: true,
                retryDelay: {
                    await retryGate.pauseIgnoringCancellation()
                    try Task.checkCancellation()
                }
            )
        }

        await retryGate.waitUntilReached()
        await first.close()
        await retryGate.release()
        let opened = try await replacement.value

        #expect(opened.isEditable)
        await opened.close()
        #expect(await components.registry.openDocumentIds.isEmpty)
    }

    @MainActor
    @Test("a frozen editor rolls back visible text and resumes after refused sign-out")
    func editorFence() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Fence")
        let model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        components.auth.attach(sessions: components.registry)

        let freeze = await components.registry.freezeAndFlushAll()
        #expect(!model.isEditable)
        model.storage.markdown = "must not remain visible"
        model.accept(model.storage.markdown)
        #expect(model.storage.markdown == "")
        await components.registry.resumeAll(after: freeze)

        await #expect(throws: RectoAuthError.unsyncedWork(count: 1)) {
            try await components.auth.signOut()
        }
        #expect(model.isEditable)
        model.storage.markdown = "accepted after refusal · 🚀"
        model.accept(model.storage.markdown)
        #expect(
            try await components.store.document(localId: document.localId)?.displayMarkdown
                == "accepted after refusal · 🚀")
        await model.close()
    }

    @MainActor
    @Test(
        "cloud editing preserves canonically equivalent UTF-16 through persistence and navigation",
        arguments: [
            ("😀 café\r\nnext\n", "😀 cafe\u{301}\r\nnext\n"),
            ("😀 cafe\u{301}\r\nnext\n", "😀 café\r\nnext\n"),
        ]
    )
    func exactCloudMarkdown(original: String, edited: String) async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Exact UTF-16")
        var model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        model.storage.markdown = original
        model.accept(original)
        await model.close()

        model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        #expect(Array(model.state.markdown.utf16) == Array(original.utf16))
        model.storage.markdown = edited
        model.accept(edited)
        let ingress = try #require(
            try await components.store.document(localId: document.localId)?.draftMarkdown)
        #expect(Array(ingress.utf16) == Array(edited.utf16))

        await model.undo()
        #expect(Array(model.storage.markdown.utf16) == Array(original.utf16))
        await model.redo()
        #expect(Array(model.storage.markdown.utf16) == Array(edited.utf16))
        await model.close()

        model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        #expect(Array(model.state.markdown.utf16) == Array(edited.utf16))
        await model.close()
    }

    @MainActor
    @Test("a model opened during a lifecycle fence starts read-only")
    func frozenOpen() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Frozen open")
        let freeze = await components.registry.freezeAndFlushAll()

        let model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)

        #expect(!model.isEditable)
        await components.registry.resumeAll(after: freeze)
        #expect(model.isEditable)
        await model.close()
    }

    @MainActor
    @Test("a rejected edit after undo rolls back to the navigated text")
    func frozenAfterUndo() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Undo fence")
        let model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)

        model.storage.markdown = "before undo"
        model.accept(model.storage.markdown)
        await model.undo()
        #expect(model.storage.markdown == "")

        let freeze = await components.registry.freezeAndFlushAll()
        model.storage.markdown = "rejected after undo"
        model.accept(model.storage.markdown)
        #expect(model.storage.markdown == "")

        await components.registry.resumeAll(after: freeze)
        await model.close()
    }
}

/// The web ↔ Mac handoff as the model drives it: `recto://document/<id>`
/// resolves to a local document, and Open in web only fires when both a
/// convex id and a web origin exist.
@Suite("web ↔ Mac handoff")
struct HandoffModelTests {
    @MainActor
    private func startedModel() async throws -> (RectoApplicationModel, RectoApplicationModel.Components) {
        let components = try await makeComponents()
        let model = RectoApplicationModel(components: components)
        await model.start()
        return (model, components)
    }

    /// A document the server has seen, so it carries a convex id.
    @MainActor
    private func assignConvexId(
        _ convexId: String, localId: String, in components: RectoApplicationModel.Components
    ) async throws {
        var record = try #require(await components.store.document(localId: localId))
        record.convexId = convexId
        try await components.store.save(record)
    }

    @MainActor
    @Test("Open in web is gated by the web origin and the document's convex id")
    func openInWebGating() async throws {
        let (model, components) = try await startedModel()
        await model.createDocument()
        let localId = try #require(model.selectedDocumentId)
        let origin = try #require(URL(string: "https://recto.example"))
        var opened: [URL] = []
        model.openURL = { opened.append($0); return true }

        // Local-only document: no convex id, so the web has no page to open.
        model.webURL = origin
        #expect(!model.canOpenSelectedDocumentInWeb)
        model.openSelectedDocumentInWeb()
        #expect(opened.isEmpty)

        try await assignConvexId("k57handoff0000000", localId: localId, in: components)
        // Signing in routes refreshDocuments through the library, so the
        // published list carries the convex id the gate reads.
        await model.receiveAuthStatus(.signedIn(userId: "test-user"))
        #expect(model.canOpenSelectedDocumentInWeb)
        model.openSelectedDocumentInWeb()
        #expect(opened == [URL(string: "https://recto.example/?doc=k57handoff0000000")!])

        // An unsigned local build: no configured origin, so the handoff is off.
        opened.removeAll()
        model.webURL = nil
        #expect(!model.canOpenSelectedDocumentInWeb)
        model.openSelectedDocumentInWeb()
        #expect(opened.isEmpty)
    }

    @MainActor
    @Test("recto://document/<id> selects the local document that carries the id")
    func linkSelectsLocalDocument() async throws {
        let (model, components) = try await startedModel()
        await model.createDocument()
        let other = try await components.library.createDocument(title: "Other")
        try await assignConvexId("k57handoff0000000", localId: other.localId, in: components)

        let handled = await model.openDocument(
            from: try #require(DocumentLink.appURL(convexId: "k57handoff0000000")))
        #expect(handled)
        #expect(model.selectedDocumentId == other.localId)
        #expect(model.errorMessage == nil)
    }

    @MainActor
    @Test("an unknown document link surfaces a note instead of crashing")
    func unknownLinkReports() async throws {
        let (model, _) = try await startedModel()
        await model.createDocument()
        let before = model.selectedDocumentId

        let handled = await model.openDocument(
            from: try #require(DocumentLink.appURL(convexId: "k57nosuch0000000")))
        #expect(handled)
        #expect(model.selectedDocumentId == before)
        #expect(model.errorMessage == "This document isn't on this Mac yet. Sign in and wait for it to sync, then open the link again.")
    }

    @MainActor
    @Test("anything that is not a document link changes nothing")
    func garbageLinksRejected() async throws {
        let (model, _) = try await startedModel()
        for string in [
            "https://example.com/?doc=k57handoff0000000",
            "recto://other/k57handoff0000000",
            "recto://document/a/b",
            "recto://document/k57handoff0000000?x=1",
        ] {
            let handled = await model.openDocument(from: try #require(URL(string: string)))
            #expect(!handled, "should reject \(string)")
        }
        #expect(model.errorMessage == nil)
        #expect(model.selectedDocumentId == nil)
    }
}

/// Two panes on one document: one model, one ingress, every storage in step.
@Suite("panes sharing a document")
struct PaneDocumentTests {
    @MainActor
    @Test("a second pane mirrors the first; an edit in either reaches the other at once and persists once")
    func mirrorsStayInStep() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Panes")
        let panes = PaneDocuments()
        let (first, firstStorage) = try await panes.acquire(document.localId, registry: components.registry)
        let (second, secondStorage) = try await panes.acquire(document.localId, registry: components.registry)
        #expect(first === second, "one model per document per window")
        #expect(firstStorage === first.storage)
        #expect(secondStorage !== firstStorage)

        secondStorage.markdown = "typed in the second pane"
        first.accept(RectoEditorEdit(markdown: secondStorage.markdown, structural: false), from: secondStorage)
        #expect(firstStorage.markdown == "typed in the second pane", "the sibling updates on the same turn")

        firstStorage.markdown = "then the first 🚀"
        first.accept(RectoEditorEdit(markdown: firstStorage.markdown, structural: false), from: firstStorage)
        #expect(secondStorage.markdown == "then the first 🚀")
        await first.save()
        #expect(try await components.store.document(localId: document.localId)?.displayMarkdown == "then the first 🚀")

        // The session groups quick edits into one step, so where undo lands is
        // its business; that it lands in every pane is the panes'.
        await first.undo()
        #expect(firstStorage.markdown != "then the first 🚀")
        #expect(secondStorage.markdown == firstStorage.markdown, "history reaches every pane")

        await panes.release(document.localId, storage: secondStorage)
        #expect(await components.registry.openDocumentIds == [document.localId], "still open for the first pane")
        await panes.release(document.localId, storage: firstStorage)
        #expect(await components.registry.openDocumentIds.isEmpty, "the last pane closes it")
    }

    @MainActor
    @Test("closing the first pane keeps the second editing")
    func firstPaneCloses() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Panes")
        let panes = PaneDocuments()
        let (model, firstStorage) = try await panes.acquire(document.localId, registry: components.registry)
        let (_, secondStorage) = try await panes.acquire(document.localId, registry: components.registry)
        await panes.release(document.localId, storage: firstStorage)

        secondStorage.markdown = "still writing"
        model.accept(RectoEditorEdit(markdown: secondStorage.markdown, structural: false), from: secondStorage)
        await model.save()
        #expect(try await components.store.document(localId: document.localId)?.displayMarkdown == "still writing")
        await panes.release(document.localId, storage: secondStorage)
    }
}

/// The pane views themselves, in a window, over the in-memory backend.
@Suite("pane views", .serialized)
struct PaneViewTests {
    @MainActor
    private final class Harness {
        var layout: PaneLayout
        init(_ documentId: String) { layout = PaneLayout(documentId: documentId) }
    }

    @MainActor
    private struct PaneHost: View {
        let harness: Harness
        let documents: PaneDocuments
        let registry: DocumentSessionRegistry
        let settings: StudioSettings

        var body: some View {
            PaneTreeView(node: harness.layout.root) { pane in
                if let localId = pane.documentId {
                    CloudDocumentView(
                        localId: localId, registry: registry,
                        panes: PaneContext(
                            documents: documents, paneId: pane.id,
                            isActive: pane.id == harness.layout.activePaneId,
                            activate: {}, commands: PaneCommands()),
                        settings: settings)
                        .id("\(pane.id)-\(localId)")
                }
            }
            .frame(width: 1_000, height: 600)
        }
    }

    private func textViews(in view: NSView) -> [NSTextView] {
        (view as? NSTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
    }

    @MainActor
    @Test("a vertical split shows two editors side by side, and typing in one shows in the other")
    func splitEditsBoth() async throws {
        _ = NSApplication.shared
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Split")
        let defaults = UserDefaults(suiteName: "com.bhekani.recto.tests.panes")!
        defaults.removePersistentDomain(forName: "com.bhekani.recto.tests.panes")
        let settings = StudioSettings(defaults: defaults, systemAppearance: { .dark })
        let harness = Harness(document.localId)
        harness.layout.split(.columns)
        let documents = PaneDocuments()
        let host = NSHostingView(rootView: PaneHost(
            harness: harness, documents: documents, registry: components.registry, settings: settings))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1_000, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderBack(nil)
        defer { window.contentView = nil; window.close() }

        var views: [NSTextView] = []
        for _ in 0..<200 {
            host.layoutSubtreeIfNeeded()
            views = textViews(in: host).filter { $0.isEditable }
            if views.count == 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(views.count == 2, "one editor per pane")
        let frames = views.map { $0.convert($0.bounds, to: nil) }.sorted { $0.minX < $1.minX }
        #expect(frames.count == 2 && frames[0].maxX <= frames[1].minX + 1, "side by side: \(frames)")

        let left = views.min { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }!
        let right = views.first { $0 !== left }!
        window.makeFirstResponder(left)
        left.insertText("From the left pane.", replacementRange: NSRange(location: 0, length: 0))
        #expect(right.string.contains("From the left pane."), "the other pane has it on the same turn")
    }
}
