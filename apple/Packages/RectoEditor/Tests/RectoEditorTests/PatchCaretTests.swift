//
//  PatchCaretTests.swift
//  RectoEditorTests
//
//  A remote edit, a history jump or a canonicalisation must not move the
//  reader's caret. Run against a 10k-word document, because the failure mode
//  this replaces — rebuilding the storage — is the one that only hurts at size.
//

import AppKit
import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("Patch caret preservation")
struct PatchCaretTests {

    /// ~10k words: 400 paragraphs of prose with inline syntax, plus a code
    /// block and a table every twentieth paragraph.
    static func longDocument() -> String {
        var out = "---\ntitle: Sediment\n---\n\n"
        for index in 0..<400 {
            out += "## Section \(index)\n\n"
            out += "The **sediment** settles into *layers* that record the weather"
            out += " of a year, and the `core` taken from the lake bed reads like"
            out += " a [ledger](https://example.com) of every summer since the ice left.\n\n"
            if index % 20 == 0 {
                out += "```swift\nlet depth = \(index) // cm\n```\n\n"
                out += "| year | depth |\n| --- | --- |\n| \(1900 + index) | \(index) |\n\n"
            }
        }
        return out
    }

    @Test("a patch at the top of a 10k-word document leaves the caret on its word")
    func caretSurvivesRemotePatch() {
        let document = Self.longDocument()
        let harness = EditorHarness(markdown: document)
        let ns = document as NSString
        let anchor = ns.range(of: "Section 300")
        #expect(anchor.location != NSNotFound)
        let caret = anchor.location + 4
        harness.textView.setSelectedRange(NSRange(location: caret, length: 0))

        // Someone else retitles the document, 60k characters away.
        let titleRange = ns.range(of: "title: Sediment")
        #expect(harness.storage.apply(
            MarkdownTextPatch(range: titleRange, replacement: "title: Varves and weather")))

        let delta = ("title: Varves and weather" as NSString).length - titleRange.length
        #expect(harness.textView.selectedRange() == NSRange(location: caret + delta, length: 0))
        #expect((harness.textView.string as NSString)
            .substring(with: NSRange(location: caret + delta, length: 7)) == "ion 300")
    }

    @Test("the storage string and the text view agree after a patch")
    func storageAndViewAgree() {
        let harness = EditorHarness(markdown: Self.longDocument())
        let range = (harness.storage.markdown as NSString).range(of: "Section 12")
        #expect(harness.storage.apply(MarkdownTextPatch(range: range, replacement: "Chapter 12")))
        #expect(harness.textView.string == harness.storage.markdown)
        #expect(harness.storage.markdown.contains("## Chapter 12"))
    }

    @Test("assigning markdown wholesale reconciles by patch, not by rebuild")
    func assignmentReconcilesByPatch() {
        let harness = EditorHarness(markdown: "alpha\n\nbravo\n\ncharlie\n")
        harness.textView.setSelectedRange(NSRange(location: 15, length: 0))

        harness.storage.markdown = "alpha\n\nBRAVO\n\ncharlie\n"

        #expect(harness.textView.string == "alpha\n\nBRAVO\n\ncharlie\n")
        #expect(harness.textView.selectedRange() == NSRange(location: 15, length: 0))
    }

    @Test("frontmatter is re-read whenever the document changes")
    func frontmatterTracksTheDocument() {
        let harness = EditorHarness(markdown: "---\ntitle: One\n---\n\nBody\n")
        #expect(harness.storage.frontmatter?.title == "One")

        let range = (harness.storage.markdown as NSString).range(of: "One")
        #expect(harness.storage.apply(MarkdownTextPatch(range: range, replacement: "Two")))
        #expect(harness.storage.frontmatter?.title == "Two")
    }

    @Test("an out-of-range patch is refused and leaves both sides untouched")
    func outOfRangePatchRefused() {
        let harness = EditorHarness(markdown: "alpha")
        #expect(harness.storage.apply(
            MarkdownTextPatch(range: NSRange(location: 3, length: 90), replacement: "x")) == false)
        #expect(harness.storage.markdown == "alpha")
        #expect(harness.textView.string == "alpha")
    }
}
