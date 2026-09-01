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
    private(set) var isEditable = true

    private let session: DocumentSession
    private let registry: DocumentSessionRegistry
    private let edits: OrderedDocumentEdits
    private var ingressId: UUID?
    private var stateTask: Task<Void, Never>?
    private var isClosed = false

    static func open(
        localId: String,
        registry: DocumentSessionRegistry,
        waitForEditableHolder: Bool = false,
        afterIngressRegistered: (@MainActor @Sendable () async -> Void)? = nil,
        retryDelay: (@MainActor @Sendable () async throws -> Void)? = nil
    ) async throws -> CloudDocumentModel {
        while true {
            do {
                return try await openOnce(
                    localId: localId,
                    registry: registry,
                    afterIngressRegistered: afterIngressRegistered
                )
            } catch SessionError.editableHolderExists where waitForEditableHolder {
                try Task.checkCancellation()
                if let retryDelay {
                    try await retryDelay()
                } else {
                    try await Task.sleep(for: .milliseconds(10))
                }
            }
        }
    }

    private static func openOnce(
        localId: String,
        registry: DocumentSessionRegistry,
        afterIngressRegistered: (@MainActor @Sendable () async -> Void)?
    ) async throws -> CloudDocumentModel {
        let session = try await registry.session(for: localId)
        var model: CloudDocumentModel?
        do {
            try Task.checkCancellation()
            let state = await session.currentState
            try Task.checkCancellation()
            guard let state else { throw SessionError.notOpen }
            let opened = CloudDocumentModel(
                localId: localId,
                state: state,
                session: session,
                registry: registry
            )
            model = opened
            opened.edits.onAcceptanceChanged = { [weak opened] accepting in
                opened?.isEditable = accepting
            }
            opened.ingressId = try await registry.registerIngress(
                for: localId, opened.edits)
            await afterIngressRegistered?()
            try Task.checkCancellation()
            opened.isEditable = opened.edits.isAccepting
            return opened
        } catch {
            if let model {
                await model.close()
            } else {
                await registry.release(localId)
            }
            throw error
        }
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
        edits = OrderedDocumentEdits(
            store: registry.store, documentLocalId: localId, initialMarkdown: state.markdown
        ) { change in
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
                adopt(updated)
            }
        }
    }

    var pendingEditCount: Int { edits.pendingCount }
    var editError: String? { edits.lastError ?? edits.lastTitleError ?? errorMessage }

    func accept(_ markdown: String) {
        guard markdown != storage.markdown || markdown != state.markdown else { return }
        if !edits.accept(markdown: markdown) {
            storage.markdown = edits.lastAcceptedMarkdown
        }
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
            if let updated = await session.currentState { adopt(updated) }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func perform(_ action: () async throws -> Void) async {
        await edits.waitUntilDrained()
        do {
            try await action()
            if let updated = await session.currentState { adopt(updated) }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func adopt(_ updated: DocumentState) {
        state = updated
        guard edits.pendingCount == 0 else { return }
        edits.adoptAuthoritativeMarkdown(updated.markdown)
        if storage.markdown != updated.markdown { storage.markdown = updated.markdown }
    }
}
