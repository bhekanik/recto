import Foundation
import Observation
import RectoCore
import RectoEditor

@MainActor
@Observable
final class CloudDocumentModel {
    let localId: String
    let storage: RectoTextStorage
    private(set) var state: DocumentState
    private(set) var errorMessage: String?

    private let session: DocumentSession
    private let registry: DocumentSessionRegistry
    private let edits: OrderedDocumentEdits
    private var ingressId: UUID?
    private var stateTask: Task<Void, Never>?
    private var isClosed = false

    static func open(localId: String, registry: DocumentSessionRegistry) async throws
        -> CloudDocumentModel {
        let session = try await registry.session(for: localId)
        guard let state = await session.currentState else {
            await registry.release(localId)
            throw SessionError.notOpen
        }
        let model = CloudDocumentModel(
            localId: localId,
            state: state,
            session: session,
            registry: registry
        )
        model.ingressId = await registry.registerIngress(model.edits)
        return model
    }

    private init(
        localId: String,
        state: DocumentState,
        session: DocumentSession,
        registry: DocumentSessionRegistry
    ) {
        self.localId = localId
        self.state = state
        self.session = session
        self.registry = registry
        storage = RectoTextStorage(documentId: localId, markdown: state.markdown)
        edits = OrderedDocumentEdits(store: registry.store, documentLocalId: localId) { change in
            try await session.applyPersistedLocalChange(
                markdown: change.markdown,
                selection: change.selection,
                structural: change.structural,
                generation: change.generation
            )
        }
        stateTask = Task { [weak self] in
            for await updated in await session.states {
                guard let self else { return }
                self.state = updated
                if edits.pendingCount == 0, storage.markdown != updated.markdown {
                    storage.markdown = updated.markdown
                }
            }
        }
    }

    var pendingEditCount: Int { edits.pendingCount }
    var editError: String? { edits.lastError ?? errorMessage }

    func accept(_ markdown: String) {
        guard markdown != storage.markdown || markdown != state.markdown else { return }
        edits.accept(markdown: markdown)
    }

    func undo() async {
        await performNavigation { try await session.undo() }
    }

    func redo() async {
        await performNavigation { try await session.redo() }
    }

    func keepLocalBranch() async {
        await perform {
            try await session.resolveDivergenceKeepingLocal()
        }
    }

    func keepRemoteBranch() async {
        await perform {
            try await session.resolveDivergenceKeepingRemote()
        }
    }

    func close() async {
        guard !isClosed else { return }
        isClosed = true
        stateTask?.cancel()
        await edits.freezeAndDrain()
        do {
            try await session.flush()
        } catch {
            errorMessage = error.localizedDescription
        }
        if let ingressId {
            await registry.unregisterIngress(ingressId)
            self.ingressId = nil
        }
        await registry.release(localId)
    }

    private func performNavigation(_ action: () async throws -> Bool) async {
        await edits.waitUntilDrained()
        do {
            _ = try await action()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func perform(_ action: () async throws -> Void) async {
        await edits.waitUntilDrained()
        do {
            try await action()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
