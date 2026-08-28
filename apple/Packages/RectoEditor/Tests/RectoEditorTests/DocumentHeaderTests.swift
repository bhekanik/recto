//
//  DocumentHeaderTests.swift
//  RectoEditorTests
//
//  Frontmatter is hidden from the body, so the title only exists on screen if
//  the header renders it. These mount the real view in a real window and look
//  at geometry and pixels: deleting the header, or rendering the wrong field,
//  fails them — which reading `storage.frontmatter` back would not.
//

import AppKit
import Foundation
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
extension RealWindowTests {
@Suite("Document header renders")
struct DocumentHeaderTests {

    private static func document(title: String = "The Varve Record") -> String {
        """
        ---
        title: \(title)
        subtitle: A year in a millimetre
        subject: Issue 12
        preview: What a millimetre of silt remembers
        ---

        Body after frontmatter.
        """
    }

    private func mount(_ markdown: String, _ presentation: Presentation) -> WindowHarness {
        let storage = RectoTextStorage(documentId: "header", markdown: markdown)
        let styler = MarkdownStyler(presentation: presentation, theme: .twilight)
        return WindowHarness(RectoEditorView(storage: storage, styler: styler))
    }

    @Test("rich and preview draw a header band with ink in it",
          arguments: [Presentation.rich, .preview])
    func headerBandRenders(presentation: Presentation) {
        let harness = mount(Self.document(), presentation)
        defer { harness.tearDown() }

        let band = harness.headerBand
        #expect(band.height > 20,
                "\(presentation.rawValue): no header band — the title is hidden in the body and drawn nowhere")
        #expect(harness.inkCoverage(in: band) > 0.01,
                "\(presentation.rawValue): the header band is blank")
    }

    @Test("the header draws the title it was given, not some other field")
    func headerFollowsTheTitle() {
        // Ink coverage, not an exact bitmap hash: two windows rendering the
        // same text do not produce byte-identical output (measured — the
        // fingerprints differ run to run), but how much of the band is inked
        // tracks what is actually written in it.
        func coverage(_ title: String) -> Double {
            let harness = mount(Self.document(title: title), .rich)
            defer { harness.tearDown() }
            return harness.inkCoverage(in: harness.headerBand)
        }
        let short = coverage("Varves")
        let long = coverage("Reading lake beds one millimetre at a time")
        let shortAgain = coverage("Varves")

        #expect(short > 0.01)
        #expect(abs(short - shortAgain) < 0.005, "the same header did not render the same twice")
        #expect(long > short + 0.005, "the header renders the same whatever the title says")
    }

    @Test("raw shows the source and draws no header band")
    func rawHasNoHeader() {
        let harness = mount(Self.document(), .raw)
        defer { harness.tearDown() }

        #expect(harness.editorTextView?.string.contains("title: The Varve Record") == true)
        #expect(harness.headerBand.height == 0, "raw drew a header band over its own source")
    }

    @Test("a document with no frontmatter draws no header band")
    func noFrontmatterNoHeader() {
        let harness = mount("# Just a heading\n\nBody.\n", .rich)
        defer { harness.tearDown() }
        #expect(harness.editorTextView?.string.contains("Just a heading") == true)
        #expect(harness.headerBand.height == 0)
    }

    @Test("a block of only metadata draws no header band")
    func metadataOnlyRendersNothing() {
        let harness = mount("---\ntags:\n  - one\ndate: 2026-01-15\n---\n\nBody.\n", .rich)
        defer { harness.tearDown() }
        #expect(harness.editorTextView?.string.contains("Body.") == true)
        #expect(harness.headerBand.height == 0,
                "a header of nothing but tags and dates should not reserve a band")
    }

    @Test("the body still holds every character of the hidden block")
    func sourceIsIntact() {
        let harness = mount(Self.document(), .rich)
        defer { harness.tearDown() }
        #expect(harness.editorTextView?.string == Self.document())
    }
}
}
