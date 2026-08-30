import Combine
import RectoCore
import RectoHistory
import RectoStore

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
    }

    typealias Submit = @Sendable (Change) async throws -> Void

    @Published private(set) var pendingCount = 0
    @Published private(set) var lastError: String?
    @Published private(set) var isAccepting = true
    private(set) var lastAcceptedMarkdown: String
    var onAcceptanceChanged: ((Bool) -> Void)?

    private let store: RectoStore
    private let documentLocalId: String
    private let countWords: @Sendable (String) -> Int
    private let continuation: AsyncStream<Change>.Continuation
    private var worker: Task<Void, Never>?
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []

    init(
        store: RectoStore,
        documentLocalId: String,
        countWords: @escaping @Sendable (String) -> Int = RectoWordCount.plainText,
        initialMarkdown: String = "",
        submit: @escaping Submit
    ) {
        self.store = store
        self.documentLocalId = documentLocalId
        self.countWords = countWords
        lastAcceptedMarkdown = initialMarkdown
        let pair = AsyncStream<Change>.makeStream()
        continuation = pair.continuation
        worker = Task { [weak self] in
            for await change in pair.stream {
                do {
                    try await submit(change)
                    self?.didFinish(error: nil)
                } catch {
                    self?.didFinish(error: error)
                }
            }
        }
    }

    deinit {
        continuation.finish()
        worker?.cancel()
    }

    @discardableResult
    func accept(markdown: String, selection: NodeSelection? = nil, structural: Bool = false) -> Bool {
        guard isAccepting else { return false }
        do {
            let generation = try store.saveEditorIngressSynchronously(
                documentLocalId: documentLocalId,
                markdown: markdown,
                selection: selection,
                wordCount: countWords(markdown)
            )
            pendingCount += 1
            lastAcceptedMarkdown = markdown
            continuation.yield(
                Change(
                    markdown: markdown,
                    selection: selection,
                    structural: structural,
                    generation: generation
                )
            )
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func waitUntilDrained() async {
        guard pendingCount > 0 else { return }
        await withCheckedContinuation { continuation in
            drainWaiters.append(continuation)
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
    }

    private func didFinish(error: (any Error)?) {
        pendingCount = max(pendingCount - 1, 0)
        lastError = error.map { String(describing: $0) }
        guard pendingCount == 0 else { return }
        let waiters = drainWaiters
        drainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}
