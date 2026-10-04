import Foundation
import Observation
import RectoStore

@MainActor
@Observable
final class OverflowModel {
    private final class WeakModel {
        weak var value: OverflowModel?
        init(_ value: OverflowModel) { self.value = value }
    }
    private static var models: [String: WeakModel] = [:]
    private(set) var record: OverflowRecord
    var errorMessage: String?
    private(set) var unsavedMarkdown: String?
    var displayMarkdown: String { unsavedMarkdown ?? record.markdown }
    private let store: RectoStore
    private var observation: Task<Void, Never>?

    static func open(store: RectoStore, localId: String) throws -> OverflowModel {
        let key = "\(ObjectIdentifier(store)):\(localId)"
        if let model = models[key]?.value { return model }
        let model = try OverflowModel(store: store, localId: localId)
        models[key] = WeakModel(model)
        return model
    }

    private init(store: RectoStore, localId: String) throws {
        self.store = store
        record = try store.overflow(localId: localId)
        observation = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self else { return }
                do {
                    let updated = try store.overflow(localId: localId)
                    if updated != record { record = updated }
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    isolated deinit { observation?.cancel() }

    @discardableResult
    func accept(_ markdown: String, expectedGeneration: Int? = nil) -> Bool {
        do {
            record = try store.saveOverflow(localId: record.documentLocalId, markdown: markdown, expectedGeneration: expectedGeneration ?? record.generation)
            errorMessage = nil
            unsavedMarkdown = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            unsavedMarkdown = markdown
            return false
        }
    }

    func retryUnsaved() {
        if let unsavedMarkdown { _ = accept(unsavedMarkdown) }
    }

    func resolve(keepLocal: Bool) {
        guard unsavedMarkdown == nil else { return }
        do {
            record = try store.resolveOverflow(localId: record.documentLocalId, keepLocal: keepLocal, expectedGeneration: record.generation)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
}
