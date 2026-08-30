import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@Suite("Markdown line endings")
struct MarkdownLineEndingTests {
    @Test("detects CRLF and LF without changing the source")
    func detection() {
        #expect(MarkdownLineEnding(detecting: "a\r\nb") == .carriageReturnLineFeed)
        #expect(MarkdownLineEnding(detecting: "a\nb") == .lineFeed)
        #expect(MarkdownLineEnding(detecting: "") == .lineFeed)
        #expect(MarkdownLineEnding(detecting: "no final newline") == .lineFeed)
    }

    @Test("normalizes pasted newlines to the document convention")
    func pastedNewlines() throws {
        let edit = try #require(MarkdownLineEnding.carriageReturnLineFeed.applying(
            MarkdownTextMutation(
                range: NSRange(location: 3, length: 0),
                replacement: "x\ny\r\nz\rw"
            ),
            to: "a\r\n"
        ))

        #expect(edit.markdown == "a\r\nx\r\ny\r\nz\r\nw")
        #expect(edit.mutation.replacement == "x\r\ny\r\nz\r\nw")
    }

    @Test("replacement cannot split a CRLF pair")
    func replacementAtBoundary() throws {
        let deletingLineFeed = try #require(
            MarkdownLineEnding.carriageReturnLineFeed.applying(
                MarkdownTextMutation(range: NSRange(location: 2, length: 1), replacement: ""),
                to: "a\r\nb"
            )
        )
        #expect(deletingLineFeed.markdown == "ab")
        #expect(deletingLineFeed.mutation.range == NSRange(location: 1, length: 2))

        let insertingInside = try #require(
            MarkdownLineEnding.carriageReturnLineFeed.applying(
                MarkdownTextMutation(range: NSRange(location: 2, length: 0), replacement: "x"),
                to: "a\r\nb"
            )
        )
        #expect(insertingInside.markdown == "a\r\nxb")
    }

    @Test("unchanged mixed line endings remain byte-exact")
    func unchangedBytes() throws {
        let source = "first\r\nsecond\nthird"
        let edit = try #require(MarkdownLineEnding.carriageReturnLineFeed.applying(
            MarkdownTextMutation(range: NSRange(location: 5, length: 0), replacement: "!"),
            to: source
        ))

        #expect(edit.markdown == "first!\r\nsecond\nthird")
    }
}
