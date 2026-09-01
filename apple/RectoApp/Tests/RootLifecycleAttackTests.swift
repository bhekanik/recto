import Foundation
import RectoCore
import RectoStore
import RectoSync
import Testing

@testable import RectoAuth

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

private actor CrashTitleGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func derive(_ markdown: String) async -> String {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        guard !released else { return markdown }
        await withCheckedContinuation { releaseWaiters.append($0) }
        return markdown
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

private final class CrashTitleCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storedCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return storedCount
    }

    func derive(_ markdown: String) -> String {
        lock.lock()
        storedCount += 1
        lock.unlock()
        return markdown
    }
}

@Suite("root lifecycle attacks")
struct RootLifecycleAttackTests {
    enum TitleCrashPoint: CaseIterable {
        case afterBodyCommit
        case afterBodyOnlyAcknowledgement
        case manualAfterBodyCommit
        case titleBeforeBodyCommit
    }

    @MainActor
    @Test("sign-out rejects a document created after its final unsynced count")
    func createDuringSignOutGap() async throws {
        let store = try RectoStore.inMemory()
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let auth = RectoAuth(store: store)
        auth.attach(sessions: registry)
        let gate = LifecycleGate()
        auth.convexAuthProvider.convexLogout = { await gate.suspendWrite() }

        let signingOut = Task { try await auth.signOut() }
        await gate.waitUntilStarted()

        await #expect(throws: StoreError.localMutationsFrozen) {
            _ = try await library.createDocument(title: "rejected in the gap")
        }

        await gate.release()
        try await signingOut.value
        #expect(try await store.documents().isEmpty)
    }

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
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
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
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
            )
        }
        _ = try await registry.registerIngress(for: document.localId, queue)

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
        #expect(promoted.title == expected)
        #expect(promoted.draftMarkdown == nil)
        #expect(promoted.syncState == .pending)
        #expect(try await reopenedStore.pendingJobCount() == 2)
        let commit = try #require(
            try await reopenedStore.pendingJobs(documentLocalId: document.localId)
                .first { $0.kind == .commitEdit }
        )
        #expect(try OutboxPayload.decode(commit.payload).title == expected)
    }

    @MainActor
    @Test("a clean-head title repair survives process loss", arguments: TitleCrashPoint.allCases)
    func cleanHeadTitleRepairSurvivesRelaunch(crashPoint: TitleCrashPoint) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "recto-title-crash-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appending(path: "recto.sqlite")
        let store = try RectoStore(url: databaseURL)
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Before")
        let originalCounter = CrashTitleCounter()
        let session = DocumentSession(
            documentLocalId: document.localId,
            store: store,
            sync: nil,
            origin: "mac",
            deriveTitle: { originalCounter.derive($0) },
            schedulesTimers: false
        )
        try await session.open()
        let bodyGate = LifecycleGate()
        let titleGate = CrashTitleGate()
        if crashPoint == .titleBeforeBodyCommit { await titleGate.release() }
        let markdown = "# Recovered title"
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await titleGate.derive($0) }
        ) { change in
            if crashPoint == .titleBeforeBodyCommit { await bodyGate.suspendWrite() }
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: true,
                generation: change.generation
            )
        }

        #expect(queue.accept(markdown: markdown, structural: true))
        if crashPoint == .titleBeforeBodyCommit {
            await bodyGate.waitUntilStarted()
            for _ in 0..<100 where try await store.document(localId: document.localId)?.title != markdown {
                await Task.yield()
            }
            #expect(try await store.document(localId: document.localId)?.title == markdown)
            await bodyGate.release()
            await queue.waitUntilDrained()
        } else {
            await titleGate.waitUntilStarted()
            for _ in 0..<100 {
                let jobs = try await store.pendingJobs(documentLocalId: document.localId)
                if jobs.contains(where: { $0.kind == .commitEdit }) { break }
                await Task.yield()
            }
        }

        if crashPoint == .manualAfterBodyCommit {
            _ = try await library.renameDocument(localId: document.localId, title: "Before")
        } else if crashPoint == .afterBodyOnlyAcknowledgement {
            let jobs = try await store.pendingJobs(documentLocalId: document.localId)
            for job in jobs {
                if job.kind == .draftSave {
                    try await store.acknowledgeEditorIngress(
                        documentLocalId: document.localId,
                        markdown: markdown,
                        title: nil
                    )
                }
                try await store.completeJob(id: try #require(job.id))
            }
        }

        let beforeCrash = try #require(try await store.document(localId: document.localId))
        #expect(beforeCrash.markdown == markdown)
        #expect(beforeCrash.draftMarkdown == markdown)
        #expect(beforeCrash.editorIngressRevision != nil)
        #expect(originalCounter.count == 0)
        let nodeCount = try await store.nodes(documentLocalId: document.localId).count

        queue.invalidate()
        await titleGate.release()

        let reopenedStore = try RectoStore(url: databaseURL)
        let reopenedCounter = CrashTitleCounter()
        let reopenedSession = DocumentSession(
            documentLocalId: document.localId,
            store: reopenedStore,
            sync: nil,
            origin: "mac",
            deriveTitle: { reopenedCounter.derive($0) },
            schedulesTimers: false
        )
        try await reopenedSession.open()

        let recovered = try #require(try await reopenedStore.document(localId: document.localId))
        #expect(try await reopenedStore.nodes(documentLocalId: document.localId).count == nodeCount)
        if crashPoint == .manualAfterBodyCommit {
            #expect(reopenedCounter.count == 0)
            #expect(recovered.title == "Before")
            #expect(recovered.titleMode == .manual)
        } else {
            #expect(reopenedCounter.count == 1)
            #expect(recovered.title == markdown)
            #expect(recovered.titleMode == .derived)
            let jobs = try await reopenedStore.pendingJobs(documentLocalId: document.localId)
            let repairIndex = try #require(jobs.lastIndex { $0.kind == .draftSave })
            if let commitIndex = jobs.lastIndex(where: { $0.kind == .commitEdit }) {
                #expect(commitIndex < repairIndex)
            }
            let payload = try OutboxPayload.decode(jobs[repairIndex].payload)
            #expect(payload.markdown == markdown)
            #expect(payload.title == markdown)
        }
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
        _ = try await registry.registerIngress(for: document.localId, queue)
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
            // Durable ingress marker, create, body commit, then title repair.
            #expect(error as? RectoAuthError == .unsyncedWork(count: 4))
        }
        #expect(try await store.document(localId: document.localId)?.displayMarkdown == expected)
        let afterRefusal = try await library.createDocument(title: "Accepted after refusal")
        #expect(try await store.document(localId: afterRefusal.localId) != nil)
    }
}
