//
//  StorageFrontmatterTests.swift
//  RectoEditorTests
//
//  The document header's data contract. Design §4.2 renders frontmatter as the
//  header (title, subtitle, newsletter subject and preview) rather than as
//  YAML, and the editor hides the block from the body — so the parsed fields
//  have to be available from the storage, and have to stay correct as the
//  reader edits them. The header VIEW is stage 2; this is what it will read.
//

import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("Document header data")
struct StorageFrontmatterTests {

    private static let document = """
    ---
    title: The Varve Record
    subtitle: A year in a millimetre
    subject: Issue 12 — reading lake beds
    preview: What a millimetre of silt remembers
    ---

    Body after frontmatter.
    """

    @Test("the four header fields are available as soon as the storage exists")
    func fieldsAvailableAtInit() throws {
        let storage = RectoTextStorage(documentId: "d", markdown: Self.document)
        let header = try #require(storage.frontmatter)
        #expect(header.title == "The Varve Record")
        #expect(header.subtitle == "A year in a millimetre")
        #expect(header.subject == "Issue 12 — reading lake beds")
        #expect(header.preview == "What a millimetre of silt remembers")
    }

    @Test("a document with no frontmatter has no header")
    func noFrontmatterNoHeader() {
        #expect(RectoTextStorage(documentId: "d", markdown: "# Just a heading\n").frontmatter == nil)
        #expect(RectoTextStorage(documentId: "d").frontmatter == nil)
    }

    @Test("assigning markdown re-reads the header")
    func assignmentUpdatesHeader() {
        let storage = RectoTextStorage(documentId: "d", markdown: Self.document)
        storage.markdown = Self.document.replacingOccurrences(
            of: "title: The Varve Record", with: "title: Varves")
        #expect(storage.frontmatter?.title == "Varves")
        #expect(storage.frontmatter?.subtitle == "A year in a millimetre")
    }

    @Test("patching a field re-reads the header, with the editor attached")
    func patchUpdatesHeader() {
        let harness = EditorHarness(markdown: Self.document)
        let range = (harness.storage.markdown as NSString).range(of: "Issue 12 — reading lake beds")
        #expect(harness.storage.apply(MarkdownTextPatch(range: range, replacement: "Issue 13")))
        #expect(harness.storage.frontmatter?.subject == "Issue 13")
        #expect(harness.storage.frontmatter?.title == "The Varve Record")
    }

    @Test("deleting the block clears the header")
    func deletingBlockClearsHeader() {
        let storage = RectoTextStorage(documentId: "d", markdown: Self.document)
        #expect(storage.frontmatter != nil)
        storage.markdown = "Body after frontmatter.\n"
        #expect(storage.frontmatter == nil)
    }

    @Test("the header claims exactly the block, never the body")
    func rangeClaimsTheBlockOnly() throws {
        let storage = RectoTextStorage(documentId: "d", markdown: Self.document)
        let header = try #require(storage.frontmatter)
        let claimed = (storage.markdown as NSString).substring(with: header.range)
        #expect(claimed.hasPrefix("---\n"))
        #expect(claimed.hasSuffix("---\n"))
        #expect(!claimed.contains("Body after frontmatter."))
    }

    @Test("the editor hides the block from the body but keeps every character")
    func blockIsHiddenNotRemoved() throws {
        let harness = EditorHarness(markdown: Self.document)
        // The string is the document: hiding is an attribute, never a deletion.
        #expect(harness.textView.string == Self.document)
        let storage = try #require(harness.textView.textStorage)
        let header = try #require(harness.storage.frontmatter)
        for index in header.range.location..<NSMaxRange(header.range) {
            let isNewline = CharacterSet.newlines.contains(
                UnicodeScalar((storage.string as NSString).character(at: index)) ?? " ")
            #expect(isNewline || ReaderView.isHidden(storage, at: index),
                    "character \(index) of the frontmatter block is visible")
        }
    }
}
