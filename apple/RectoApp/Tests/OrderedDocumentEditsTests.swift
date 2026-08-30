import RectoCore
import RectoHistory
import RectoStore
import Testing

@testable import Recto

private actor EditGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func suspendFirstWrite() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

@Suite("ordered editor changes")
struct OrderedDocumentEditsTests {
    @MainActor
    @Test("a suspended first write cannot be overtaken by the next editor snapshot")
    func preservesAcceptedOrder() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Queue test")
        let session = DocumentSession(
            documentLocalId: document.localId,
            store: store,
            sync: nil,
            origin: "mac",
            schedulesTimers: false
        )
        try await session.open()
        let gate = EditGate()
        let first = "first"
        let second = "second wins · 中文 · 🚀"
        let queue = OrderedDocumentEdits(store: store, documentLocalId: document.localId) { change in
            if change.markdown == first {
                await gate.suspendFirstWrite()
            }
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
            )
        }

        queue.accept(markdown: first)
        queue.accept(markdown: second)
        await gate.waitUntilStarted()
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == second)

        await gate.release()
        await queue.waitUntilDrained()

        #expect(queue.lastError == nil)
        #expect(queue.pendingCount == 0)
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == second)
        #expect(await session.currentState?.markdown == second)
    }

    @MainActor
    @Test("reverting to the clean head while an older submit is suspended stays synced")
    func suspendedCleanRevert() async throws {
        let store = try RectoStore.inMemory()
        let localId = "clean-revert"
        try await store.save(DocumentRecord(
            localId: localId,
            title: "Clean revert",
            markdown: "clean",
            wordCount: 1,
            localHeadNodeId: "root",
            remoteHeadNodeId: "root",
            syncState: .synced,
            updatedAt: 0,
            createdAt: 0
        ))
        try await store.mergeRemoteNodes(
            documentLocalId: localId,
            nodes: [DocNodeRecord(
                documentLocalId: localId,
                nodeId: "root",
                parentNodeId: nil,
                patch: TextPatch(from: 0, to: 0, insert: "clean").encoded,
                snapshot: "clean",
                origin: "server",
                createdAt: 0
            )]
        )
        let session = DocumentSession(
            documentLocalId: localId,
            store: store,
            sync: nil,
            origin: "mac",
            schedulesTimers: false
        )
        try await session.open()
        let gate = EditGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: localId,
            initialMarkdown: "clean"
        ) { change in
            if change.markdown == "A" { await gate.suspendFirstWrite() }
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
            )
        }

        queue.accept(markdown: "A")
        await gate.waitUntilStarted()
        queue.accept(markdown: "clean")

        let reverted = try #require(try await store.document(localId: localId))
        #expect(reverted.draftMarkdown == nil)
        #expect(reverted.syncState == .synced)

        await gate.release()
        await queue.waitUntilDrained()

        let settled = try #require(try await store.document(localId: localId))
        #expect(settled.displayMarkdown == "clean")
        #expect(settled.syncState == .synced)
        #expect(try await store.pendingJobs(documentLocalId: localId).isEmpty)
        #expect(await session.currentState?.markdown == "clean")
    }
}
