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
        let queue = OrderedDocumentEdits { change in
            if change.markdown == first {
                await gate.suspendFirstWrite()
            }
            try await session.applyLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural
            )
        }

        queue.accept(markdown: first)
        queue.accept(markdown: second)
        await gate.waitUntilStarted()
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == "")

        await gate.release()
        await queue.waitUntilDrained()

        #expect(queue.lastError == nil)
        #expect(queue.pendingCount == 0)
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == second)
        #expect(await session.currentState?.markdown == second)
    }
}
