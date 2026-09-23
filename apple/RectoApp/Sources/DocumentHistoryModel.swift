import AppKit
import Observation
import RectoHistory
import RectoSync

/// The two views of the history panel, the web's `HistoryView`.
enum HistoryView: String {
    case tree
    case versions
}

/// What the history panel shows for one synced document: the undo tree from
/// the local node store, the server's tagged versions, and a preview or a
/// two-way compare.
@MainActor
@Observable
final class DocumentHistoryModel {
    struct Row: Equatable, Identifiable {
        let node: DocNode
        let depth: Int
        var id: String { node.nodeId }
    }

    private(set) var rows: [Row] = []
    private(set) var versions: [RemoteVersion] = []
    /// The text of the row under the pointer.
    private(set) var preview: String?
    /// Up to two nodes picked for compare; two make a diff.
    private(set) var compareSelection: [String] = []
    private(set) var compareTexts: (a: String, b: String)?
    var errorMessage: String?

    @ObservationIgnored private let document: CloudDocumentModel
    @ObservationIgnored private var cloud: CloudDocumentContext?
    @ObservationIgnored private var versionsTask: Task<Void, Never>?

    init(document: CloudDocumentModel) {
        self.document = document
    }

    var currentNodeId: String { document.state.head }

    func versions(at nodeId: String) -> [RemoteVersion] {
        versions.filter { $0.nodeId == nodeId }
    }

    func reloadNodes() async {
        rows = Self.flatten(await document.historyNodes())
    }

    /// Follow `versions.list` while the panel is up; the document needs its
    /// server id first.
    func followVersions(_ cloud: CloudDocumentContext?) {
        self.cloud = cloud
        versionsTask?.cancel()
        guard let cloud, let convexId = cloud.convexId else {
            versions = []
            return
        }
        versionsTask = Task { [weak self] in
            let stream: AsyncThrowingStream<[RemoteVersion], any Error> =
                await cloud.api.subscribe(ConvexFunction.versionsList, args: ["documentId": .string(convexId)])
            do {
                for try await list in stream { self?.versions = list }
            } catch {
                self?.errorMessage = error.localizedDescription
            }
        }
    }

    func stop() {
        versionsTask?.cancel()
        versionsTask = nil
    }

    func showPreview(of nodeId: String?) async {
        guard let nodeId else {
            preview = nil
            return
        }
        preview = try? await document.markdown(at: nodeId)
    }

    func navigate(to nodeId: String) async {
        await document.navigate(to: nodeId)
        await reloadNodes()
    }

    func restore(_ nodeId: String) async {
        await document.restore(nodeId)
        await reloadNodes()
    }

    /// The web's `setCompareSelection`: toggle, keep the last two.
    func toggleCompare(_ nodeId: String) async {
        if let index = compareSelection.firstIndex(of: nodeId) {
            compareSelection.remove(at: index)
        } else {
            compareSelection = Array((compareSelection + [nodeId]).suffix(2))
        }
        guard compareSelection.count == 2,
              let a = try? await document.markdown(at: compareSelection[0]),
              let b = try? await document.markdown(at: compareSelection[1])
        else {
            compareTexts = nil
            return
        }
        compareTexts = (a, b)
    }

    /// Tag the current node on the server. The node must be there before a
    /// version can point at it (`versions.create` refuses an unknown node), so
    /// this Mac's edits are pushed first.
    @discardableResult
    func tagCurrent(label: String) async -> Bool {
        guard let cloud, let convexId = cloud.convexId else {
            errorMessage = "This document hasn't synced yet, so it can't be tagged."
            return false
        }
        guard await cloud.syncForExport() else {
            errorMessage = "Some changes haven't synced yet. Try again once they have."
            return false
        }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.versionsCreate, args: [
                "documentId": .string(convexId), "nodeId": .string(document.state.head),
                "label": .string(label), "kind": "manual",
            ])
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func rename(_ version: RemoteVersion, to label: String) async {
        await versionMutation(ConvexFunction.versionsRename, version, extra: ["label": .string(label)])
    }

    func remove(_ version: RemoteVersion) async {
        await versionMutation(ConvexFunction.versionsRemove, version)
    }

    private func versionMutation(_ name: String, _ version: RemoteVersion, extra: [String: ConvexValue] = [:]) async {
        guard let cloud, let convexId = cloud.convexId else { return }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(
                name, args: ["documentId": .string(convexId), "versionId": .string(version.id)].merging(extra) { $1 })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The web's `flattenTree`: children oldest first; the first child keeps its
    /// parent's column and later branches step right.
    static func flatten(_ nodes: [DocNode]) -> [Row] {
        let byId = Dictionary(nodes.map { ($0.nodeId, $0) }, uniquingKeysWith: { first, _ in first })
        var children: [String?: [String]] = [:]
        for node in nodes.sorted(by: { $0.createdAt < $1.createdAt }) {
            children[node.parentNodeId, default: []].append(node.nodeId)
        }
        var rows: [Row] = []
        func visit(_ id: String, _ depth: Int) {
            guard let node = byId[id] else { return }
            rows.append(Row(node: node, depth: depth))
            for (index, child) in (children[id] ?? []).enumerated() {
                visit(child, index == 0 ? depth : depth + 1)
            }
        }
        for (index, root) in (children[nil] ?? []).enumerated() {
            visit(root, index)
        }
        return rows
    }
}

/// A one-line question with a default answer, as the web's `window.prompt`.
@MainActor
enum TextPrompt {
    static func ask(_ title: String, defaultValue: String, confirm: String = "OK") -> String? {
        let alert = NSAlert()
        alert.messageText = title
        let field = NSTextField(string: defaultValue)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue
    }
}
