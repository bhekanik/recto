import Combine
import Foundation
import RectoCore
import RectoHistory
import RectoStore
import RectoSync

/// Bridges RectoEditor's synchronous callback to one async document session.
/// One consumer processes full Markdown snapshots in acceptance order. The UI
/// can enqueue synchronously without starting an unstructured task per edit.
@MainActor
final class OrderedDocumentEdits: ObservableObject, EditorIngressCoordinating {
    struct Change: Sendable, Equatable {
        var markdown: String
        var selection: NodeSelection?
        var structural: Bool
        var generation: Int
        var wordCount: Int
        /// Names the node this change becomes (`ai:<label>`); nil is the device's.
        var origin: String? = nil
        var orderedReceipt: UUID? = nil
    }

    typealias Submit = @Sendable (Change) async throws -> Void
    typealias DeriveTitle = @Sendable (String) async -> String
    typealias PublishTitle = @Sendable (Change, String) async throws -> Void

    @Published private(set) var pendingCount = 0
    @Published private(set) var lastError: String?
    @Published private(set) var lastTitleError: String?
    @Published private(set) var isAccepting = true
    private(set) var lastAcceptedMarkdown: String
    var onAcceptanceChanged: ((Bool) -> Void)?

    private let store: RectoStore
    private let documentLocalId: String
    private let countWords: @Sendable (String) -> Int
    private let deriveTitle: DeriveTitle
    private let publishTitle: PublishTitle
    private let continuation: AsyncStream<Change>.Continuation
    private var worker: Task<Void, Never>?
    private var receipts: Set<UUID> = []
    private let tracksHistoryReceipts: Bool
    private var pendingTitle: Change?
    private var titleWorker: Task<Void, Never>?
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []
    private var titleDrainWaiters: [CheckedContinuation<Void, Never>] = []

    init(
        store: RectoStore,
        documentLocalId: String,
        countWords: @escaping @Sendable (String) -> Int = RectoWordCount.plainText,
        deriveTitle: @escaping DeriveTitle = { markdown in
            await Task.detached(priority: .userInitiated) {
                RectoDocumentTitle.derive(markdown)
            }.value
        },
        publishTitle: PublishTitle? = nil,
        initialMarkdown: String = "",
        tracksHistoryReceipts: Bool = false,
        submit: @escaping Submit
    ) {
        self.store = store
        self.documentLocalId = documentLocalId
        self.countWords = countWords
        self.tracksHistoryReceipts = tracksHistoryReceipts
        self.deriveTitle = deriveTitle
        self.publishTitle = publishTitle ?? { change, title in
            let titleJob = OutboxJob(
                documentLocalId: documentLocalId,
                kind: .draftSave,
                clientMutationId: ulid(),
                payload: OutboxPayload(
                    title: title,
                    markdown: change.markdown,
                    wordCount: change.wordCount
                ).encoded,
                createdAt: Date().timeIntervalSince1970 * 1_000
            )
            _ = try await store.finishEditorIngressTitle(
                documentLocalId: documentLocalId,
                markdown: change.markdown,
                expectedDraftRevision: change.generation,
                title: title,
                job: titleJob
            )
        }
        lastAcceptedMarkdown = initialMarkdown
        let pair = AsyncStream<Change>.makeStream()
        continuation = pair.continuation
        worker = Task { [weak self] in
            for await change in pair.stream {
                var failure: (any Error)?
                do { try await submit(change) } catch { failure = error }
                if let receipt = change.orderedReceipt {
                    do {
                        try store.completeOrderedEditorReceipt(documentLocalId: documentLocalId, receipt: receipt)
                    } catch { failure = failure ?? error }
                    self?.receipts.remove(receipt)
                }
                self?.didFinish(error: failure)
            }
        }
    }

    deinit {
        continuation.finish()
        worker?.cancel()
        titleWorker?.cancel()
        for receipt in receipts {
            try? store.completeOrderedEditorReceipt(documentLocalId: documentLocalId, receipt: receipt)
        }
    }

    @discardableResult
    func accept(
        markdown: String, selection: NodeSelection? = nil, structural: Bool = false, origin: String? = nil
    ) -> Bool {
        guard isAccepting else { return false }
        do {
            let wordCount = countWords(markdown)
            let receipt = tracksHistoryReceipts ? UUID() : nil
            let generation = try store.saveEditorIngressSynchronously(
                documentLocalId: documentLocalId,
                markdown: markdown,
                selection: selection,
                wordCount: wordCount,
                title: nil,
                clientMutationId: ulid(),
                draftPayload: OutboxPayload(
                    title: nil, markdown: markdown, wordCount: wordCount
                ).encoded,
                orderedReceipt: receipt
            )
            if let receipt { receipts.insert(receipt) }
            pendingCount += 1
            lastAcceptedMarkdown = markdown
            let change = Change(
                markdown: markdown,
                selection: selection,
                structural: structural,
                generation: generation,
                wordCount: wordCount,
                origin: origin,
                orderedReceipt: receipt
            )
            continuation.yield(change)
            enqueueTitle(change)
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func waitUntilDrained() async {
        if pendingCount > 0 {
            await withCheckedContinuation { continuation in
                drainWaiters.append(continuation)
            }
        }
        if pendingTitle != nil || titleWorker != nil {
            await withCheckedContinuation { continuation in
                titleDrainWaiters.append(continuation)
            }
        }
    }

    func drain() async {
        await waitUntilDrained()
    }

    func freezeAndDrain() async {
        isAccepting = false
        onAcceptanceChanged?(false)
        await waitUntilDrained()
    }

    func resume() {
        isAccepting = true
        onAcceptanceChanged?(true)
    }

    func adoptAuthoritativeMarkdown(_ markdown: String) {
        guard pendingCount == 0 else { return }
        lastAcceptedMarkdown = markdown
    }

    func invalidate() {
        isAccepting = false
        onAcceptanceChanged?(false)
        continuation.finish()
        worker?.cancel()
        worker = nil
        for receipt in receipts {
            try? store.completeOrderedEditorReceipt(documentLocalId: documentLocalId, receipt: receipt)
        }
        receipts.removeAll()
        pendingCount = 0
        let waiters = drainWaiters
        drainWaiters.removeAll()
        waiters.forEach { $0.resume() }
        pendingTitle = nil
        titleWorker?.cancel()
        titleWorker = nil
        finishTitleDrain()
    }

    private func didFinish(error: (any Error)?) {
        pendingCount = max(pendingCount - 1, 0)
        lastError = error.map { String(describing: $0) }
        guard pendingCount == 0 else { return }
        let waiters = drainWaiters
        drainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func enqueueTitle(_ change: Change) {
        pendingTitle = change
        guard titleWorker == nil else { return }
        titleWorker = Task { [weak self] in await self?.runTitleLane() }
    }

    private func runTitleLane() async {
        while !Task.isCancelled, let change = pendingTitle {
            pendingTitle = nil
            let title = await deriveTitle(change.markdown)
            guard !Task.isCancelled else { break }
            do {
                try await publishTitle(change, title)
                lastTitleError = nil
            } catch {
                lastTitleError = String(describing: error)
            }
        }
        titleWorker = nil
        finishTitleDrain()
    }

    private func finishTitleDrain() {
        guard pendingTitle == nil, titleWorker == nil else { return }
        let waiters = titleDrainWaiters
        titleDrainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}
