import RectoAuth
import RectoCore
import RectoStore
import RectoSync
import Testing

@testable import Recto

private actor TestTransport: RectoTransport {
    enum Failure: Error { case unexpectedCall }

    func createDocument(title: String, documentUuid: String) async throws
        -> CreateDocumentResponse { throw Failure.unexpectedCall }
    func commitEdit(_ request: CommitEditRequest) async throws
        -> CommitEditResponse { throw Failure.unexpectedCall }
    func updateCurrentNodeId(
        documentId: String, currentNodeId: String, markdown: String, wordCount: Int,
        updatedAt: Double, expectedPointerRevision: Double?
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

@MainActor
private func makeComponents(
    beforeAuthConsumption: (@MainActor @Sendable () async -> Void)? = nil
) async throws -> RectoApplicationModel.Components {
    let store = try RectoStore.inMemory()
    let transport = TestTransport()
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
    @Test("a frozen editor rolls back visible text and resumes after refused sign-out")
    func editorFence() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Fence")
        let model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)
        components.auth.attach(sessions: components.registry)

        await components.registry.freezeAndFlushAll()
        #expect(!model.isEditable)
        model.storage.markdown = "must not remain visible"
        model.accept(model.storage.markdown)
        #expect(model.storage.markdown == "")
        await components.registry.resumeAll()

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
    @Test("a model opened during a lifecycle fence starts read-only")
    func frozenOpen() async throws {
        let components = try await makeComponents()
        let document = try await components.library.createDocument(title: "Frozen open")
        await components.registry.freezeAndFlushAll()

        let model = try await CloudDocumentModel.open(
            localId: document.localId, registry: components.registry)

        #expect(!model.isEditable)
        await components.registry.resumeAll()
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

        await components.registry.freezeAndFlushAll()
        model.storage.markdown = "rejected after undo"
        model.accept(model.storage.markdown)
        #expect(model.storage.markdown == "")

        await components.registry.resumeAll()
        await model.close()
    }
}
