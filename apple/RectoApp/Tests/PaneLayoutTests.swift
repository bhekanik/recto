import Foundation
import Testing
@testable import Recto

/// `lib/workspace/operations.test.ts`'s cases, on the Mac's pane tree.
@Suite("Pane layout")
struct PaneLayoutTests {
    private func shape(_ node: PaneLayout.Node) -> String {
        switch node {
        case .pane(let pane): pane.documentId ?? "-"
        case .split(_, let axis, let children):
            "\(axis == .columns ? "C" : "R")(\(children.map(shape).joined(separator: ",")))"
        }
    }

    @Test("a split clones the active document and focuses the new pane")
    func splitClones() {
        var layout = PaneLayout(documentId: "a")
        let first = layout.activePaneId
        let split = layout.split(.columns)
        #expect(split)
        #expect(shape(layout.root) == "C(a,a)")
        #expect(layout.activePaneId != first)
    }

    @Test("same-direction splits join the group; a different direction nests")
    func flattenAndNest() {
        var layout = PaneLayout(documentId: "a")
        layout.split(.columns)
        layout.setActiveDocument("b")
        layout.split(.columns)
        #expect(shape(layout.root) == "C(a,b,b)")
        layout.split(.rows)
        #expect(shape(layout.root) == "C(a,b,R(b,b))")
    }

    @Test("closing collapses a group of one and moves focus on")
    func closeCollapses() {
        var layout = PaneLayout(documentId: "a")
        layout.split(.columns)
        layout.setActiveDocument("b")
        layout.split(.rows)
        layout.closeActive()
        #expect(shape(layout.root) == "C(a,b)")
        #expect(layout.activePane?.documentId == "b")
        layout.closeActive()
        #expect(shape(layout.root) == "a")
    }

    @Test("closing the last pane leaves one empty pane, never none")
    func neverEmpty() {
        var layout = PaneLayout(documentId: "a")
        layout.closeActive()
        #expect(layout.panes.count == 1)
        #expect(layout.activePane?.documentId == nil)
    }

    @Test("focus cycles in tree order and wraps both ways")
    func focusCycles() {
        var layout = PaneLayout(documentId: "a")
        layout.split(.columns)
        layout.setActiveDocument("b")
        layout.split(.rows)
        layout.setActiveDocument("c")
        let ids = layout.panes.map(\.id)
        layout.focus(by: 1)
        #expect(layout.activePaneId == ids[0])
        layout.focus(by: -1)
        #expect(layout.activePaneId == ids[2])
    }

    @Test("the web's six-pane limit")
    func limit() {
        var layout = PaneLayout(documentId: "a")
        for _ in 0..<5 {
            let split = layout.split(.columns)
            #expect(split)
        }
        let overLimit = layout.split(.rows)
        #expect(!overLimit)
        #expect(layout.panes.count == PaneLayout.maxPanes)
    }
}
