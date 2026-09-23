import Foundation
import Testing

@testable import Recto

@Suite("Export filenames and HTML")
struct ExportFileTests {
    /// The web's `lib/export/export.test.ts` cases, plus the whitespace
    /// collapse the regex performs.
    @Test(arguments: [
        ("a/b:c*?\"<>|d", "a-b-c------d"),
        ("  spaced  out  ", "spaced out"),
        ("", "untitled"),
        ("line\nbreak\ttab", "line break tab"),
        ("My / Draft: v2?", "My - Draft- v2-"),
    ])
    func safeFilename(title: String, expected: String) {
        #expect(ExportFile.safeFilename(title) == expected)
    }

    @Test("the length cap counts UTF-16 units like the web's slice")
    func capsAt120Units() {
        let capped = ExportFile.safeFilename(String(repeating: "x", count: 200))
        #expect(capped.utf16.count == 120)
        #expect(capped == String(repeating: "x", count: 120))
    }

    @Test("the wrapper is the web's standalone document")
    func standaloneWrapper() {
        let html = ExportFile.generateExportHtml(
            markdown: "# Heading\n\nBody.\n",
            title: "My Doc",
            bodyHtml: "<h1>Heading</h1>\n<p>Body.</p>"
        )
        #expect(html.hasPrefix("<!doctype html>\n<html lang=\"en\">"))
        #expect(html.contains("<meta charset=\"utf-8\">"))
        #expect(html.contains("<title>My Doc</title>"))
        #expect(html.contains("<style>:root { color-scheme: light; }"))
        #expect(html.contains(".recto-doc-header hr { margin: 1.2rem 0 2rem; }"))
        #expect(html.contains("<body>\n<h1>Heading</h1>\n<p>Body.</p>\n</body>"))
        #expect(!html.contains("<header class=\"recto-doc-header\">"), "no frontmatter header without frontmatter")
    }

    @Test("frontmatter becomes the document header; the arg title is the fallback")
    func frontmatterHeader() {
        let md = "---\ntitle: Secret\nsubtitle: A subtitle\n---\n\n# Heading\n\nA **paragraph**.\n"
        let html = ExportFile.generateExportHtml(
            markdown: md,
            title: "My Doc",
            bodyHtml: "<h1>Heading</h1>\n<p>A <strong>paragraph</strong>.</p>"
        )
        #expect(html.contains("<title>Secret</title>"))
        #expect(html.contains("<header class=\"recto-doc-header\">"))
        #expect(html.contains("<h1>Secret</h1>"))
        #expect(html.contains("<p class=\"recto-subtitle\">A subtitle</p>"))
        #expect(html.contains("<hr>"))
        #expect(html.contains("<strong>paragraph</strong>"))
        // The raw YAML block never leaks as text into the body.
        #expect(!html.contains("title: Secret"))
    }

    @Test("titles are HTML-escaped like the web's escapeHtml")
    func escapesHtml() {
        let html = ExportFile.generateExportHtml(
            markdown: "# A & B <tag>\n",
            title: "A & B <tag>",
            bodyHtml: ""
        )
        #expect(html.contains("<title>A &amp; B &lt;tag&gt;</title>"))
    }

    /// The rest of `generateExportHtml` is covered above with the body handed
    /// in; this one pins the whole path through the shared JS core, the same
    /// render the web's export pipeline seeds its wrapper with.
    @Test("exportHtml renders the body through the shared JS core")
    func exportHtmlThroughCore() async throws {
        let html = try await ExportFile.exportHtml(
            markdown: "| a | b |\n| - | - |\n| 1 | 2 |\n",
            title: "T",
            core: SharedRectoCore.core()
        )
        #expect(html.contains("<title>T</title>"))
        #expect(html.contains("<table>"))
        #expect(html.contains("<td>1</td>"))
    }

    @Test("the core is the process's one load")
    func sharedCoreIsOneInstance() async throws {
        let a = try await SharedRectoCore.core()
        let b = try await SharedRectoCore.core()
        #expect(a === b)
    }
}