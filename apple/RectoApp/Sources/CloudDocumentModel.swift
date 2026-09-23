import Foundation
import Observation
import RectoCore
import RectoEditor
import RectoHistory

@MainActor
@Observable
final class CloudDocumentModel {
    let localId: String
    let storage: RectoTextStorage
    private(set) var state: DocumentState
    private(set) var errorMessage: String?
    private(set) var isEditable = true

    /// Extra editors on this document: a second pane in the same window. The
    /// engine attaches one view per storage and the session accepts one
    /// editor ingress per document, so a sibling pane gets its own storage and
    /// this model keeps every storage in step and funnels all their edits
    /// through its one ordered ingress.
    private var mirrors: [RectoTextStorage] = []
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
                generation: change.generation,
                origin: change.origin
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
        accept(RectoEditorEdit(markdown: markdown, structural: false))
    }

    func accept(_ edit: RectoEditorEdit) {
        accept(edit, from: storage)
    }

    /// An edit typed into `source`. The other storages take it at once, on
    /// this turn, so a writer switching panes never types over stale text;
    /// then it joins the ordered queue like any edit.
    func accept(_ edit: RectoEditorEdit, from source: RectoTextStorage, origin: String? = nil) {
        let markdown = edit.markdown
        guard !(markdown as NSString).isEqual(to: source.markdown)
            || !(markdown as NSString).isEqual(to: state.markdown)
        else { return }
        for sibling in allStorages where sibling !== source {
            sibling.markdown = markdown
        }
        if !edits.accept(markdown: markdown, structural: edit.structural, origin: origin) {
            for storage in allStorages { storage.markdown = edits.lastAcceptedMarkdown }
        }
    }

    /// A storage for another pane on this document, starting where the others are.
    func makeMirror() -> RectoTextStorage {
        let mirror = RectoTextStorage(documentId: "\(localId)#\(UUID().uuidString)", markdown: storage.markdown)
        mirrors.append(mirror)
        return mirror
    }

    func removeMirror(_ mirror: RectoTextStorage) {
        mirrors.removeAll { $0 === mirror }
    }

    private var allStorages: [RectoTextStorage] { [storage] + mirrors }

    /// `:w`. Drain what the editor produced and force-commit the session's
    /// draft, the same thing closing the window does short of releasing it.
    func save() async {
        await edits.waitUntilDrained()
        do {
            try await session.flush()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// `:w`, then wait for the sync state to reach `.synced`, polling the
    /// session's published state for at most `timeout`. `false` offline or on
    /// a sync failure, which leaves the server behind this Mac.
    func syncForExport(timeout: Duration = .seconds(5)) async -> Bool {
        await save()
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if edits.pendingCount == 0, state.syncState == .synced { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return edits.pendingCount == 0 && state.syncState == .synced
    }

    func undo() async {
        await performNavigation { try await session.undo() }
    }

    func redo() async {
        await performNavigation { try await session.redo() }
    }

    // MARK: - History panel

    func historyNodes() async -> [DocNode] {
        await session.historyNodes()
    }

    func markdown(at nodeId: String) async throws -> String {
        try await session.markdown(at: nodeId)
    }

    /// A pointer move to any node: the undo tree's click.
    func navigate(to nodeId: String) async {
        await performNavigation {
            try await session.navigate(to: nodeId)
            return true
        }
    }

    /// The web's additive restore (D9): the version's text becomes a new node
    /// on top of the current one, so nothing after it is lost.
    func restore(_ nodeId: String) async {
        do {
            let text = try await session.markdown(at: nodeId)
            for storage in allStorages { storage.markdown = text }
            accept(RectoEditorEdit(markdown: text, structural: true), from: storage)
            await save()
        } catch {
            errorMessage = error.localizedDescription
        }
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
        for storage in allStorages where !(storage.markdown as NSString).isEqual(to: updated.markdown) {
            storage.markdown = updated.markdown
        }
    }
}

// MARK: - RectoEditorHistory

extension CloudDocumentModel: RectoEditorHistory {
    /// `DocumentSession` is an actor, so the step cannot land inside the
    /// keystroke. It is started here and reaches the editor as the storage
    /// change `adopt` makes; vim then follows the caret the engine's patch
    /// mapping produces (near the change, not vim-exact) until B4 gives the
    /// session a synchronous head/parent cache (plan 024).
    func performHistory(_ direction: RectoHistoryDirection) -> RectoHistoryOutcome? {
        switch direction {
        case .undo: Task { await undo() }
        case .redo: Task { await redo() }
        }
        return nil
    }

    /// Every `onEdit` is its own session node until B4 groups them.
    func beginCommandGroup() {}

    func endCommandGroup() {}
}
