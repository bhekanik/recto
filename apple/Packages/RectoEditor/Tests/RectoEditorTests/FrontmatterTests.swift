//
//  FrontmatterTests.swift
//  RectoEditorTests
//

import Foundation
import Testing
@testable import RectoEditor

@Suite("Frontmatter")
struct FrontmatterTests {

    @Test("reads the top-level scalars and claims the whole block")
    func readsScalars() throws {
        let markdown = """
        ---
        title: Hello
        subtitle: A subtitle
        subject: Issue 12
        preview: What is inside
        ---

        Body after frontmatter.
        """
        let frontmatter = try #require(Frontmatter.parse(markdown))
        #expect(frontmatter.title == "Hello")
        #expect(frontmatter.subtitle == "A subtitle")
        #expect(frontmatter.subject == "Issue 12")
        #expect(frontmatter.preview == "What is inside")
        #expect((markdown as NSString).substring(with: frontmatter.range).hasSuffix("---\n"))
        #expect(!(markdown as NSString).substring(with: frontmatter.range).contains("Body"))
    }

    @Test("nested sequences and mappings do not become top-level keys")
    func skipsNestedStructure() throws {
        // Corpus case 12.
        let markdown = """
        ---
        title: Hello
        tags:
          - one
          - two
        meta:
          nested: true
        date: 2026-01-15
        ---

        Body after frontmatter.
        """
        let frontmatter = try #require(Frontmatter.parse(markdown))
        #expect(frontmatter.title == "Hello")
        #expect(frontmatter["date"] == "2026-01-15")
        // `tags:` and `meta:` are present as keys with no scalar value; their
        // children are not keys of their own.
        #expect(frontmatter.fields.map(\.key) == ["title", "tags", "meta", "date"])
        #expect(frontmatter["tags"] == nil)
        #expect(frontmatter["nested"] == nil)
    }

    @Test("an unterminated opener is a thematic break, not frontmatter")
    func unterminatedIsNotFrontmatter() {
        #expect(Frontmatter.parse("---\ntitle: Hello\n\nBody\n") == nil)
    }

    @Test("a block that does not start at the top is not frontmatter")
    func mustBeAtTheTop() {
        #expect(Frontmatter.parse("Intro\n\n---\ntitle: Hello\n---\n") == nil)
    }

    @Test("quotes around a value are stripped")
    func stripsQuotes() throws {
        let frontmatter = try #require(Frontmatter.parse("---\ntitle: \"Quoted\"\n---\n"))
        #expect(frontmatter.title == "Quoted")
    }

    @Test("a document with no frontmatter parses to nil")
    func noFrontmatter() {
        #expect(Frontmatter.parse("# Heading\n\nBody\n") == nil)
        #expect(Frontmatter.parse("") == nil)
    }
}
