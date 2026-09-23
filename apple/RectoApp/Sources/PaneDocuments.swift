import RectoCore
import RectoEditor

/// The library window's open documents, shared by its panes: one
/// `CloudDocumentModel` per document however many panes show it. The session
/// accepts one editor ingress per document, so a second pane on the same
/// document takes a mirror storage from the model instead of opening it again.
@MainActor
final class PaneDocuments {
    private struct Entry {
        let opening: Task<CloudDocumentModel, any Error>
        var holders: Int
    }

    private var entries: [String: Entry] = [:]
    private var primaries: Set<String> = []

    /// The model and the storage this pane should edit: the model's own for
    /// the first pane, a mirror for any other.
    func acquire(_ localId: String, registry: DocumentSessionRegistry) async throws
        -> (CloudDocumentModel, RectoTextStorage)
    {
        if entries[localId] == nil {
            entries[localId] = Entry(
                opening: Task { try await CloudDocumentModel.open(localId: localId, registry: registry, waitForEditableHolder: true) },
                holders: 0)
        }
        entries[localId]?.holders += 1
        let model: CloudDocumentModel
        do {
            model = try await entries[localId]!.opening.value
        } catch {
            await release(localId, storage: nil)
            throw error
        }
        if primaries.insert(localId).inserted { return (model, model.storage) }
        return (model, model.makeMirror())
    }

    /// Give back what `acquire` handed out. The last pane on a document closes it.
    func release(_ localId: String, storage: RectoTextStorage?) async {
        guard var entry = entries[localId] else { return }
        entry.holders -= 1
        let model = try? await entry.opening.value
        if let model, let storage {
            if storage === model.storage { primaries.remove(localId) } else { model.removeMirror(storage) }
        }
        guard entry.holders <= 0 else {
            entries[localId] = entry
            return
        }
        entries[localId] = nil
        primaries.remove(localId)
        await model?.close()
    }
}
