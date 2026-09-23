import Foundation
import RectoSync

/// The web's idle auto-version (blueprint 08 §4): two minutes after the head
/// stops moving, tag it `auto` as "Autosave HH:MM", never twice for the same
/// node. Only a head the server already holds is tagged; `versions.create`
/// refuses any other, and the next settle tries again.
@MainActor
final class AutoVersioning {
    static let settle: Duration = .seconds(120)

    private var pending: Task<Void, Never>?
    private var lastTagged: String?
    private let delay: Duration

    init(delay: Duration = AutoVersioning.settle) {
        self.delay = delay
    }

    func headMoved(to head: String, isSynced: @escaping @MainActor () -> Bool, cloud: CloudDocumentContext?) {
        pending?.cancel()
        guard head != lastTagged, let cloud, let convexId = cloud.convexId else { return }
        pending = Task { [weak self, delay] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, head != self.lastTagged, isSynced() else { return }
            let label = "Autosave \(Date().formatted(date: .omitted, time: .shortened))"
            do {
                let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.versionsCreate, args: [
                    "documentId": .string(convexId), "nodeId": .string(head), "label": .string(label), "kind": "auto",
                ])
                self.lastTagged = head
            } catch {
                // Background bookkeeping: a failure only means this settle had
                // no version; the next head move tries again.
            }
        }
    }

    func stop() {
        pending?.cancel()
        pending = nil
    }
}
