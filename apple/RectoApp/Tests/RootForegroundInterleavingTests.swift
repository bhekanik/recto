import RectoCore
import RectoHistory
import RectoStore
import RectoSync
import Testing

@testable import Recto
@testable import RectoAuth

private actor ForegroundCancellationGate {
    private var entered = false
    private var cancelled = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var cancellationWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func blockIgnoringCancellation() async {
        entered = true
        let waiters = entryWaiters
        entryWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withTaskCancellationHandler {
            await withCheckedContinuation { releaseWaiters.append($0) }
        } onCancel: {
            Task { await self.recordCancellation() }
        }
    }

    private func recordCancellation() {
        cancelled = true
        let waiters = cancellationWaiters
        cancellationWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func waitUntilCancelled() async {
        guard !cancelled else { return }
        await withCheckedContinuation { cancellationWaiters.append($0) }
    }

    func release() {
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor ForegroundBlockingTransport: RectoTransport {
    enum Failure: Error { case unexpectedCall }

    let bodyGate = ForegroundCancellationGate()
    private var documentContinuation:
        AsyncThrowingStream<[RemoteDocumentSummary], any Error>.Continuation?
    private(set) var documentStreamStarts = 0

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
    func getDocument(documentId: String) async throws -> RemoteDocument? {
        await bodyGate.blockIgnoringCancellation()
        return nil
    }
    func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
        documentStreamStarts += 1
        let (stream, continuation) = AsyncThrowingStream<[RemoteDocumentSummary], any Error>
            .makeStream()
        documentContinuation = continuation
        return stream
    }
    func nodesStream(documentId: String, sinceCreatedAt: Double?)
        -> AsyncThrowingStream<[RemoteNode], any Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func loginFromCache() async -> Bool { true }

    func emitNewerSummary() {
        documentContinuation?.yield([
            RemoteDocumentSummary(
                id: "remote-doc", title: "Remote", wordCount: 0, updatedAt: 2)
        ])
    }
}

@MainActor
private func makeForegroundRaceSystem() async throws -> (
    model: RectoApplicationModel,
    auth: RectoAuth,
    transport: ForegroundBlockingTransport
) {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-A")
    try await store.save(DocumentRecord(
        localId: "local-doc", convexId: "remote-doc", title: "Local", markdown: "",
        wordCount: 0, localHeadNodeId: "root", remoteHeadNodeId: "root",
        remoteUpdatedAt: 1, syncState: .synced, updatedAt: 1, createdAt: 1))
    try await store.mergeRemoteNodes(documentLocalId: "local-doc", nodes: [
        DocNodeRecord(
            documentLocalId: "local-doc", nodeId: "root", parentNodeId: nil,
            patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "",
            origin: "remote", createdAt: 1, synced: true)
    ])

    let transport = ForegroundBlockingTransport()
    let origin = try await SyncEngine.resolveOrigin(store: store)
    let sync = SyncEngine(store: store, transport: transport, origin: origin)
    let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
    let library = DocumentLibrary(store: store, sync: sync, origin: origin)
    let auth = RectoAuth(store: store)
    auth.attach(sync: sync)
    auth.attach(sessions: registry)
    let model = RectoApplicationModel(components: .init(
        store: store, auth: auth, sync: sync, registry: registry, library: library))
    await model.start()
    auth.convexAuthProvider.activeSessionID = { "session-A" }
    auth.convexAuthProvider.cachedLogin = { true }
    await auth.restoreSessionForTesting(userId: "user-A")

    for _ in 0..<100 where await transport.documentStreamStarts == 0 { await Task.yield() }
    #expect(await transport.documentStreamStarts == 1)
    await transport.emitNewerSummary()
    await transport.bodyGate.waitUntilEntered()
    return (model, auth, transport)
}

@Suite("root foreground interleaving")
struct RootForegroundInterleavingTests {
    @MainActor
    @Test("foreground never restarts sockets after sign-out overtakes its stop")
    func signOutOvertakesForegroundStop() async throws {
        let (model, auth, transport) = try await makeForegroundRaceSystem()

        let foreground = Task { await model.enterForeground() }
        await transport.bodyGate.waitUntilCancelled()
        try await auth.signOut(discardingUnsynced: true)
        #expect(auth.status == .signedOut)
        #expect(await transport.documentStreamStarts == 1)

        await transport.bodyGate.release()
        await foreground.value

        #expect(
            await transport.documentStreamStarts == 1,
            "foreground restarted a library socket after sign-out completed")
    }

    @MainActor
    @Test("foreground cannot restart the old lifecycle after an account switch")
    func accountSwitchOvertakesForegroundStop() async throws {
        let (model, auth, transport) = try await makeForegroundRaceSystem()

        let foreground = Task { await model.enterForeground() }
        await transport.bodyGate.waitUntilCancelled()
        auth.convexAuthProvider.activeSessionID = { "session-B" }
        await auth.handleSessionSwitchForTesting(from: "user-A", toUserId: "user-B")
        #expect(auth.status == .signedIn(userId: "user-B"))
        #expect(await transport.documentStreamStarts == 2)

        await transport.bodyGate.release()
        await foreground.value

        #expect(
            await transport.documentStreamStarts == 2,
            "foreground restarted a third socket after the new account started")
    }
}
