import SwiftUI

/// What the library window's panes can be asked to do, from the palette, the
/// menus or a pane's own keyboard.
struct PaneCommands {
    var split: (PaneLayout.Axis) -> Void = { _ in }
    var close: () -> Void = {}
    var focus: (Int) -> Void = { _ in }
}

/// What one pane's document view needs from its window.
struct PaneContext {
    let documents: PaneDocuments
    let paneId: UUID
    let isActive: Bool
    /// The writer moved into this pane (a click, the caret).
    let activate: () -> Void
    let commands: PaneCommands
}

/// The pane tree as nested split views, the web's `render-pane-node`. The
/// dividers are the system's, so panes resize by dragging.
struct PaneTreeView<Leaf: View>: View {
    let node: PaneLayout.Node
    @ViewBuilder let leaf: (PaneLayout.Pane) -> Leaf

    var body: some View {
        switch node {
        case .pane(let pane):
            leaf(pane)
        case .split(_, let axis, let children):
            if axis == .columns {
                HSplitView { branches(children) }
            } else {
                VSplitView { branches(children) }
            }
        }
    }

    private func branches(_ children: [PaneLayout.Node]) -> some View {
        ForEach(children, id: \.key) { child in
            PaneTreeView(node: child, leaf: leaf)
        }
    }
}

extension PaneLayout.Node {
    /// Stable identity across edits, the web's `paneKey`.
    var key: UUID {
        switch self {
        case .pane(let pane): pane.id
        case .split(let id, _, _): id
        }
    }
}
