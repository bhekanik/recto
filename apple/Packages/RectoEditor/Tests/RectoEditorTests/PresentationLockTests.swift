//
//  PresentationLockTests.swift
//  RectoEditorTests
//
//  Two windows on one document must agree on the presentation, because they
//  share a text storage and presentation-dependent styling is written into it.
//  This is the mounted view of that rule: a real window, a real update pass,
//  and assertions that hold in RELEASE too — where the engine's debug
//  assertions do not fire and only behaviour is left.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
extension RealWindowTests {
@Suite("Presentation lock, mounted")
struct PresentationLockTests {

    @Observable
    @MainActor
    final class Model {
        var showPeer: Bool
        var presentation: Presentation
        init(showPeer: Bool, presentation: Presentation) {
            self.showPeer = showPeer
            self.presentation = presentation
        }
    }

    /// Two editors on ONE storage, the second appearing and disappearing.
    private struct Host: View {
        let storage: RectoTextStorage
        let model: Model
        var body: some View {
            VStack(spacing: 0) {
                RectoEditorView(
                    storage: storage,
                    styler: MarkdownStyler(presentation: model.presentation, theme: .twilight))
                if model.showPeer {
                    RectoEditorView(
                        storage: storage,
                        styler: MarkdownStyler(presentation: .rich, theme: .twilight))
                }
            }
        }
    }

    private static let source = "## Section\n\nBody text.\n"

    @Test("a second view in a clashing presentation leaves the document intact")
    func clashingPeerDoesNotCorruptTheDocument() {
        let storage = RectoTextStorage(documentId: "lock", markdown: Self.source)
        let model = Model(showPeer: false, presentation: .rich)
        let harness = WindowHarness(Host(storage: storage, model: model))
        defer { harness.tearDown() }

        model.showPeer = true
        harness.layout()
        #expect(storage.controller.textViews.count == 2)

        // Now make the two disagree.
        model.presentation = .raw
        harness.layout()

        // Whatever the engine decided, the document is untouched and exactly
        // one storage backs it, with no orphan layout managers on it.
        #expect(storage.markdown == Self.source)
        for view in harness.allViews.compactMap({ $0 as? NSTextView }) {
            #expect(view.string == Self.source, "a view is showing something else entirely")
        }
        #expect(storage.controller.textContentStorage.textLayoutManagers.count
                == storage.controller.textViews.count,
                "a layout manager is on the storage with no attachment to match")
    }

    @Test("the switch that was refused is applied once the peer goes away")
    func refusedSwitchLandsWhenThePeerLeaves() throws {
        let storage = RectoTextStorage(documentId: "lock", markdown: Self.source)
        let model = Model(showPeer: true, presentation: .rich)
        let harness = WindowHarness(Host(storage: storage, model: model))
        defer { harness.tearDown() }
        harness.layout()
        #expect(storage.controller.textViews.count == 2)

        // Both at once, in one transaction: the peer goes and the survivor
        // switches to raw. The preflight sees the peer; nothing comes back to
        // ask again.
        model.showPeer = false
        model.presentation = .raw
        harness.layout()

        let textView = try #require(harness.editorTextView)
        #expect(textView.string == Self.source)
        let marker = textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((marker?.pointSize ?? 0) > 1,
                "the raw switch was dropped when the peer left in the same transaction")
        #expect(storage.controller.textViews.count == 1)
    }

    @Test("two views in the same presentation are fine")
    func matchingPeersAreAdmitted() {
        let storage = RectoTextStorage(documentId: "lock", markdown: Self.source)
        let model = Model(showPeer: true, presentation: .rich)
        let harness = WindowHarness(Host(storage: storage, model: model))
        defer { harness.tearDown() }
        harness.layout()

        #expect(storage.controller.textViews.count == 2)
        #expect(storage.controller.textContentStorage.textLayoutManagers.count == 2)
        let views = harness.allViews.compactMap { $0 as? NSTextView }
        #expect(views.count == 2)
        for view in views { #expect(view.string == Self.source) }

        // An edit through the document reaches both.
        let range = (storage.markdown as NSString).range(of: "Body")
        #expect(storage.apply(MarkdownTextPatch(range: range, replacement: "Text")))
        harness.layout()
        for view in harness.allViews.compactMap({ $0 as? NSTextView }) {
            #expect(view.string.contains("Text text."))
        }
    }
}
}
