import RectoCore
import RectoHistory
import RectoStore
import RectoSync
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

private actor SubmissionRecorder {
    private(set) var markdown: [String] = []
    func record(_ value: String) { markdown.append(value) }
}

private actor TitlePublisher {
    private var shouldFail = true

    func publish(_: OrderedDocumentEdits.Change, _: String) throws {
        guard shouldFail else { return }
        shouldFail = false
        struct Failure: Error {}
        throw Failure()
    }
}

private actor TitleGate {
    private var started: [String] = []
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func derive(_ markdown: String) async -> String {
        started.append(markdown)
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        guard !released else { return markdown }
        await withCheckedContinuation { releaseWaiters.append($0) }
        return markdown
    }

    func waitUntilStarted() async {
        guard !started.isEmpty else {
            await withCheckedContinuation { startWaiters.append($0) }
            return
        }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }

    var count: Int { started.count }
}

@Suite("ordered editor changes")
struct OrderedDocumentEditsTests {
#if !DEBUG
    @MainActor
    @Test("release editor ingress stays off the title parser path")
    func releaseIngressLatency() async throws {
        let samples = [
            ("50 kB heading", "# Heading\n" + String(repeating: "body ", count: 9_998), Duration.milliseconds(8)),
            ("50 kB paragraph", String(repeating: "body ", count: 10_000), Duration.milliseconds(8)),
            ("950 kB heading", "# Heading\n" + String(repeating: "body ", count: 189_998), Duration.milliseconds(60)),
            ("950 kB paragraph", String(repeating: "body ", count: 190_000), Duration.milliseconds(60)),
        ]

        for (name, markdown, budget) in samples {
            let store = try RectoStore.inMemory()
            let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
            let document = try await library.createDocument(title: name)
            let queue = OrderedDocumentEdits(
                store: store,
                documentLocalId: document.localId,
                deriveTitle: { _ in "" },
                publishTitle: { _, _ in }
            ) { _ in }
            let clock = ContinuousClock()

            #expect(queue.accept(markdown: markdown))
            let durations = (0..<7).map { _ in
                let start = clock.now
                #expect(queue.accept(markdown: markdown))
                return start.duration(to: clock.now)
            }.sorted()
            let median = durations[durations.count / 2]
            print("EDITOR_INGRESS_LATENCY \(name): samples=\(durations) p50=\(median)")
            #expect(median < budget)
            queue.invalidate()
        }
    }
#endif

    @MainActor
    @Test("accept returns while title derivation is blocked")
    func titleDerivationIsOffTheSynchronousIngress() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Latency")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await gate.derive($0) }
        ) { _ in }

        #expect(queue.accept(markdown: String(repeating: "body ", count: 10_000)))
        await gate.waitUntilStarted()
        #expect(try await store.document(localId: document.localId)?.draftMarkdown != nil)

        await gate.release()
        await queue.waitUntilDrained()
    }

    @MainActor
    @Test("continuous edits coalesce title work to the latest snapshot")
    func titleLaneIsSingleFlightLatestWins() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Coalesce")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await gate.derive($0) }
        ) { _ in }

        queue.accept(markdown: "edit 0")
        await gate.waitUntilStarted()
        for index in 1..<100 { queue.accept(markdown: "edit \(index)") }
        await gate.release()
        await queue.waitUntilDrained()

        #expect(await gate.count == 2)
        #expect(try await store.document(localId: document.localId)?.title == "edit 99")
    }

    @MainActor
    @Test("a fast body acknowledgement does not discard its delayed title")
    func acknowledgedBodyStillPublishesTitle() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Before")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { _ in await gate.derive("After") }
        ) { change in
            try await store.acknowledgeEditorIngress(
                documentLocalId: document.localId,
                markdown: change.markdown
            )
        }

        queue.accept(markdown: "")
        await gate.waitUntilStarted()
        for _ in 0..<20 { await Task.yield() }
        #expect(try await store.document(localId: document.localId)?.editorIngressRevision == nil)
        await gate.release()
        await queue.waitUntilDrained()

        #expect(try await store.document(localId: document.localId)?.title == "After")
    }

    @MainActor
    @Test("title publication failure cannot suppress body submission")
    func titleFailureDoesNotSuppressBodySubmit() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Failure")
        let recorder = SubmissionRecorder()
        let publisher = TitlePublisher()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { _ in "Derived" },
            publishTitle: { try await publisher.publish($0, $1) }
        ) { change in
            await recorder.record(change.markdown)
        }

        queue.accept(markdown: "body survives")
        await queue.waitUntilDrained()

        #expect(await recorder.markdown == ["body survives"])
        #expect(queue.lastError == nil)
        #expect(queue.lastTitleError != nil)

        queue.accept(markdown: "next body")
        await queue.waitUntilDrained()
        #expect(queue.lastTitleError == nil)
        #expect(await recorder.markdown == ["body survives", "next body"])
    }

    @MainActor
    @Test("a delayed derived title cannot overtake a newer accepted body")
    func delayedTitleIsFencedByGenerationAndMarkdown() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Original")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await gate.derive($0) }
        ) { _ in }

        queue.accept(markdown: "first")
        await gate.waitUntilStarted()
        queue.accept(markdown: "second")
        await gate.release()
        await queue.waitUntilDrained()

        let settled = try #require(try await store.document(localId: document.localId))
        #expect(settled.displayMarkdown == "second")
        #expect(settled.title == "second")
        let draft = try #require(
            try await store.pendingJobs(documentLocalId: document.localId)
                .last { $0.kind == .draftSave })
        let payload = try OutboxPayload.decode(draft.payload)
        #expect(payload.markdown == "second")
        #expect(payload.title == "second")
    }

    @MainActor
    @Test("a same-value manual rename wins over delayed title derivation")
    func manualRenameWinsDelayedTitle() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Same title")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await gate.derive($0) }
        ) { _ in }

        queue.accept(markdown: "would derive")
        await gate.waitUntilStarted()
        _ = try await library.renameDocument(localId: document.localId, title: "Same title")
        await gate.release()
        await queue.waitUntilDrained()

        let settled = try #require(try await store.document(localId: document.localId))
        #expect(settled.title == "Same title")
        #expect(settled.titleMode == .manual)
    }

    @MainActor
    @Test("invalidating ingress cancels delayed title publication")
    func invalidationCancelsDelayedTitle() async throws {
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
        let document = try await library.createDocument(title: "Original")
        let gate = TitleGate()
        let queue = OrderedDocumentEdits(
            store: store,
            documentLocalId: document.localId,
            deriveTitle: { await gate.derive($0) }
        ) { _ in }

        queue.accept(markdown: "delayed")
        await gate.waitUntilStarted()
        queue.invalidate()
        await gate.release()
        await queue.waitUntilDrained()

        #expect(try await store.document(localId: document.localId)?.title == "Original")
    }

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
        #expect(await session.currentState?.title == second)
    }

    @MainActor
    @Test("a clean revert stays durable while an older submit is suspended")
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
        #expect(reverted.draftMarkdown == "clean")
        #expect(reverted.editorIngressRevision != nil)
        #expect(reverted.syncState == .pending)
        #expect(try await store.pendingJobs(documentLocalId: localId).count == 1)

        await gate.release()
        await queue.waitUntilDrained()

        let settled = try #require(try await store.document(localId: localId))
        #expect(settled.displayMarkdown == "clean")
        #expect(settled.editorIngressRevision != nil)
        #expect(settled.syncState == .pending)
        #expect(try await store.pendingJobs(documentLocalId: localId).count == 1)
        #expect(await session.currentState?.markdown == "clean")
    }
}
