import Foundation

/// The library window's panes: `lib/workspace`'s pane tree, without the
/// persistence. A split clones the active pane's document (the web's
/// `clonePaneForSplit`); a split in the parent's own direction joins that
/// group rather than nesting; closing collapses single-child groups and never
/// leaves the window without a pane.
struct PaneLayout: Equatable {
    /// The web's `MAX_OPEN_PANES`.
    static let maxPanes = 6

    enum Axis: Equatable {
        /// `split-v`: side by side, the new pane to the right.
        case columns
        /// `split-h`: stacked, the new pane below.
        case rows
    }

    struct Pane: Equatable, Identifiable {
        let id: UUID
        var documentId: String?
    }

    indirect enum Node: Equatable {
        case pane(Pane)
        case split(id: UUID, axis: Axis, children: [Node])

        var leaves: [Pane] {
            switch self {
            case .pane(let pane): [pane]
            case .split(_, _, let children): children.flatMap(\.leaves)
            }
        }
    }

    private(set) var root: Node
    private(set) var activePaneId: UUID

    init(documentId: String? = nil) {
        let pane = Pane(id: UUID(), documentId: documentId)
        root = .pane(pane)
        activePaneId = pane.id
    }

    var panes: [Pane] { root.leaves }
    var activePane: Pane? { panes.first { $0.id == activePaneId } }

    /// Opening a document from the library or the palette puts it in the
    /// active pane, as the web's switcher does.
    mutating func setActiveDocument(_ documentId: String?) {
        root = Self.map(root) { pane in
            pane.id == activePaneId ? Pane(id: pane.id, documentId: documentId) : pane
        }
    }

    mutating func activate(_ paneId: UUID) {
        if panes.contains(where: { $0.id == paneId }) { activePaneId = paneId }
    }

    /// `splitPane` then focus the new pane. `false` at the pane limit.
    @discardableResult
    mutating func split(_ axis: Axis) -> Bool {
        guard panes.count < Self.maxPanes, let active = activePane else { return false }
        let inserted = Pane(id: UUID(), documentId: active.documentId)
        root = Self.insert(inserted, after: active.id, axis: axis, in: root)
        activePaneId = inserted.id
        return true
    }

    /// `closePane` on the active pane; focus moves to the next pane.
    mutating func closeActive() {
        let leaves = panes
        guard leaves.count > 1 else {
            // The last pane empties rather than disappearing.
            self = PaneLayout()
            return
        }
        let index = leaves.firstIndex { $0.id == activePaneId } ?? 0
        root = Self.collapse(Self.remove(activePaneId, from: root) ?? root)
        let remaining = panes
        activePaneId = remaining[min(index, remaining.count - 1)].id
    }

    /// `nextPaneId` / `prevPaneId`: tree order, wrapping.
    mutating func focus(by step: Int) {
        let leaves = panes
        guard !leaves.isEmpty else { return }
        let index = leaves.firstIndex { $0.id == activePaneId } ?? 0
        activePaneId = leaves[((index + step) % leaves.count + leaves.count) % leaves.count].id
    }

    // MARK: - Tree edits

    private static func map(_ node: Node, _ transform: (Pane) -> Pane) -> Node {
        switch node {
        case .pane(let pane): .pane(transform(pane))
        case .split(let id, let axis, let children): .split(id: id, axis: axis, children: children.map { map($0, transform) })
        }
    }

    private static func insert(_ inserted: Pane, after target: UUID, axis: Axis, in node: Node) -> Node {
        switch node {
        case .pane(let pane) where pane.id == target:
            return .split(id: UUID(), axis: axis, children: [.pane(pane), .pane(inserted)])
        case .pane:
            return node
        case .split(let id, let splitAxis, let children):
            // Same direction: join this group next to the target.
            if splitAxis == axis, let index = children.firstIndex(where: {
                if case .pane(let pane) = $0 { return pane.id == target }
                return false
            }) {
                var joined = children
                joined.insert(.pane(inserted), at: index + 1)
                return .split(id: id, axis: splitAxis, children: joined)
            }
            return .split(id: id, axis: splitAxis, children: children.map { insert(inserted, after: target, axis: axis, in: $0) })
        }
    }

    private static func remove(_ paneId: UUID, from node: Node) -> Node? {
        switch node {
        case .pane(let pane):
            return pane.id == paneId ? nil : node
        case .split(let id, let axis, let children):
            let kept = children.compactMap { remove(paneId, from: $0) }
            return kept.isEmpty ? nil : .split(id: id, axis: axis, children: kept)
        }
    }

    /// A group of one is its child; a child group in its parent's direction
    /// joins the parent.
    private static func collapse(_ node: Node) -> Node {
        guard case .split(let id, let axis, let children) = node else { return node }
        let collapsed = children.map(collapse).flatMap { child -> [Node] in
            if case .split(_, let childAxis, let grandchildren) = child, childAxis == axis { return grandchildren }
            return [child]
        }
        return collapsed.count == 1 ? collapsed[0] : .split(id: id, axis: axis, children: collapsed)
    }
}
