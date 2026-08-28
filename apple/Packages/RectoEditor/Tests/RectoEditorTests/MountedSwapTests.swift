//
//  MountedSwapTests.swift
//  RectoEditorTests
//
//  Showing a different document in the same window, through the whole real
//  stack: SwiftUI, a mounted `NativeTextViewWrapper`, an on-screen window and
//  first responder.
//
//  The fork's own swap tests drive the sequence by hand, which is precise but
//  cannot exercise `updateNSView`'s real ordering or AppKit's attribute fixing
//  against a live responder. That is where the crash was reported, so that is
//  where this looks.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
extension RealWindowTests {
@Suite("Swapping documents in a mounted window")
struct MountedSwapTests {

    /// A window whose editor can be pointed at a different document, the way a
    /// library selection change does it.
    private struct Host: View {
        let storage: RectoTextStorage
        let styler: MarkdownStyler
        var body: some View {
            RectoEditorView(storage: storage, styler: styler)
                // Identity by document: SwiftUI rebuilds the representable
                // rather than reusing one view across two documents.
                .id(storage.documentId)
        }
    }

    private func mount(_ storage: RectoTextStorage,
                       _ presentation: Presentation = .rich) -> WindowHarness {
        WindowHarness(Host(storage: storage,
                           styler: MarkdownStyler(presentation: presentation, theme: .twilight)))
    }

    @Test("a non-zero selection into a long document survives a swap to a short one")
    func swapWithSelectionIntoLongerDocument() throws {
        let long = RectoTextStorage(
            documentId: "long",
            markdown: String(repeating: "alpha bravo charlie delta echo\n", count: 60))
        let harness = mount(long)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        let tail = (long.markdown as NSString).length - 25
        textView.setSelectedRange(NSRange(location: tail, length: 20))
        harness.layout()

        // Point the window at a much shorter document.
        let short = RectoTextStorage(documentId: "short", markdown: "short\n")
        harness.hostingView.rootView = AnyView(
            Host(storage: short, styler: MarkdownStyler(presentation: .rich, theme: .twilight)))
        harness.layout()

        let live = try #require(harness.editorTextView)
        #expect(live.string == "short\n")
        #expect(NSMaxRange(live.selectedRange()) <= (live.string as NSString).length,
                "the selection still points into the document that was swapped out")
        #expect(live.delegate != nil, "the swapped-in view has no delegate")
        #expect(live.enclosingScrollView != nil)
    }

    @Test("a swap to an empty document is safe")
    func swapToEmptyDocument() throws {
        let filled = RectoTextStorage(documentId: "filled", markdown: "alpha bravo charlie\n")
        let harness = mount(filled)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        textView.setSelectedRange(NSRange(location: 6, length: 5))
        harness.layout()

        let empty = RectoTextStorage(documentId: "empty", markdown: "")
        harness.hostingView.rootView = AnyView(
            Host(storage: empty, styler: MarkdownStyler(presentation: .rich, theme: .twilight)))
        harness.layout()

        let live = try #require(harness.editorTextView)
        #expect(live.string == "")
        #expect(live.selectedRange() == NSRange(location: 0, length: 0))
    }

    @Test("the swapped-in document is the one that gets edited")
    func editsLandInTheSwappedInDocument() throws {
        let first = RectoTextStorage(documentId: "first", markdown: "document A\n")
        let harness = mount(first)
        defer { harness.tearDown() }
        harness.layout()

        let second = RectoTextStorage(documentId: "second", markdown: "document B\n")
        harness.hostingView.rootView = AnyView(
            Host(storage: second, styler: MarkdownStyler(presentation: .rich, theme: .twilight)))
        harness.layout()

        #expect(second.apply(MarkdownTextPatch(range: NSRange(location: 10, length: 0),
                                               replacement: "!")))
        harness.layout()

        let live = try #require(harness.editorTextView)
        #expect(live.string == "document B!\n")
        #expect(first.markdown == "document A\n", "the edit reached the document left behind")
    }

    @Test("switching presentation in a single window is allowed")
    func soleWindowMaySwitchPresentation() throws {
        let storage = RectoTextStorage(documentId: "lens", markdown: "## Section\n\nBody.\n")
        let harness = mount(storage, .rich)
        defer { harness.tearDown() }
        harness.layout()
        #expect(harness.editorTextView?.string == "## Section\n\nBody.\n")

        harness.hostingView.rootView = AnyView(
            Host(storage: storage, styler: MarkdownStyler(presentation: .raw, theme: .twilight)))
        harness.layout()

        let live = try #require(harness.editorTextView)
        #expect(live.string == "## Section\n\nBody.\n", "the source must survive a lens switch")
        // Raw shows the markers at full size; rich collapses them.
        let markerFont = live.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((markerFont?.pointSize ?? 0) > 1, "the lens did not switch to raw")
    }
}
}
