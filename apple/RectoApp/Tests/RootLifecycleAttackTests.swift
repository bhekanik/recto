import Foundation
import RectoAuth
import RectoCore
import RectoStore
import Testing

@testable import Recto

private actor LifecycleGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func suspendWrite() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

@Suite("root lifecycle attacks")
struct RootLifecycleAttackTests {
    @MainActor
    @Test("a locally durable draft is not labelled synced before it reaches Convex")
    func acceptedDraftMovesTheVisibleStateToPending() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        var document = try await library.createDocument(title: "Honest status")
        document.syncState = .synced
        try await store.save(document)
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
        let session = try await registry.session(for: document.localId)
        let queue = OrderedDocumentEdits(store: store, documentLocalId: document.localId) { change in
            try await session.applyLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural
            )
        }

        queue.accept(markdown: "durable here, absent remotely")
        await queue.waitUntilDrained()

        #expect(await session.currentState?.syncState == .pending)
        await registry.release(document.localId)
    }

    @MainActor
    @Test("application flush includes editor snapshots whose submit is suspended")
    func applicationFlushIncludesTheEditorQueue() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Lifecycle")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
        let session = try await registry.session(for: document.localId)
        let gate = LifecycleGate()
        let latest = "accepted before app became inactive · 中文 · 🚀"
        let queue = OrderedDocumentEdits(store: store, documentLocalId: document.localId) { change in
            await gate.suspendWrite()
            try await session.applyLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural
            )
        }
        _ = await registry.registerIngress(queue)

        queue.accept(markdown: latest)
        await gate.waitUntilStarted()
        let flush = Task { await registry.flushAll() }

        #expect(try await store.document(localId: document.localId)?.displayMarkdown == latest)

        await gate.release()
        await flush.value
        await registry.release(document.localId)
    }


    @MainActor
    @Test("a failed final submit is recovered from the app-support database")
    func failedSubmitRecoversAfterRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "recto-ingress-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appending(path: "recto.sqlite")
        let store = try RectoStore(url: databaseURL)
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Recovery")
        let expected = "last accepted edit · café · 中文 · 🚀"
        struct SubmitFailure: Error {}
        let queue = OrderedDocumentEdits(store: store, documentLocalId: document.localId) { _ in
            throw SubmitFailure()
        }

        queue.accept(markdown: expected)
        await queue.waitUntilDrained()
        #expect(queue.lastError != nil)

        let reopenedStore = try RectoStore(url: databaseURL)
        let registry = DocumentSessionRegistry(store: reopenedStore, sync: nil, origin: "mac")
        let recoveredSession = try await registry.session(for: document.localId)
        #expect(await recoveredSession.currentState?.markdown == expected)
        let promoted = try #require(try await reopenedStore.document(localId: document.localId))
        #expect(promoted.displayMarkdown == expected)
        #expect(promoted.draftMarkdown == nil)
        #expect(promoted.syncState == .pending)
        #expect(try await reopenedStore.pendingJobCount() == 2)
    }

    @MainActor
    @Test("sign-out waits for a suspended submit and then protects the accepted edit")
    func signOutDrainsIngressBeforeCounting() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Sign out")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
        let session = try await registry.session(for: document.localId)
        let gate = LifecycleGate()
        let queue = OrderedDocumentEdits(store: store, documentLocalId: document.localId) { change in
            await gate.suspendWrite()
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
            )
        }
        _ = await registry.registerIngress(queue)
        let expected = "accepted while sign-out begins · 🚀"
        queue.accept(markdown: expected)
        await gate.waitUntilStarted()
        let auth = RectoAuth(store: store)
        auth.attach(sessions: registry)

        let signOut = Task { try await auth.signOut() }
        for _ in 0..<20 { await Task.yield() }
        await gate.release()

        do {
            try await signOut.value
            Issue.record("sign-out discarded an accepted local edit")
        } catch {
            #expect(error as? RectoAuthError == .unsyncedWork(count: 2))
        }
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == expected)
    }
}
