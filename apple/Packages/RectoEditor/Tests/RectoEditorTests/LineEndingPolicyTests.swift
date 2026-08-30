import AppKit
import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@Suite("Line-ending policy", .serialized)
@MainActor
struct LineEndingPolicyTests {
    @Test("an authoritative LF replacement changes the insertion convention")
    func authoritativeReplacementToLF() {
        let harness = EditorHarness(markdown: "a\r\nb", documentId: "to-lf")
        harness.storage.markdown = "a\nb"
        harness.textView.setSelectedRange(NSRange(location: 1, length: 0))

        harness.textView.insertNewline(nil)

        #expect(harness.textView.string == "a\n\nb")
        #expect(harness.storage.markdown == "a\n\nb")
    }

    @Test("an authoritative CRLF replacement changes the insertion convention")
    func authoritativeReplacementToCRLF() {
        let harness = EditorHarness(markdown: "single line", documentId: "to-crlf")
        harness.storage.markdown = "a\r\nb"
        harness.textView.setSelectedRange(NSRange(location: 1, length: 0))

        harness.textView.insertNewline(nil)

        #expect(harness.textView.string == "a\r\n\r\nb")
        #expect(harness.storage.markdown == "a\r\n\r\nb")
    }

    @Test("deleting the first newline adopts the first surviving convention")
    func deletingFirstNewline() {
        let harness = EditorHarness(markdown: "a\nb\r\nc", documentId: "delete-first")
        harness.textView.insertText("", replacementRange: NSRange(location: 1, length: 1))
        #expect(harness.storage.markdown == "ab\r\nc")
        harness.textView.setSelectedRange(NSRange(location: 1, length: 0))

        harness.textView.insertNewline(nil)

        #expect(harness.textView.string == "a\r\nb\r\nc")
        #expect(harness.storage.markdown == "a\r\nb\r\nc")
    }

    @Test("an external patch that replaces the first newline updates the convention")
    func replacingFirstNewline() {
        let harness = EditorHarness(markdown: "a\r\nb\nc", documentId: "replace-first")
        #expect(harness.storage.apply(MarkdownTextPatch(
            range: NSRange(location: 1, length: 2),
            replacement: "\n"
        )))
        #expect(harness.storage.markdown == "a\nb\nc")
        harness.textView.setSelectedRange(NSRange(location: 1, length: 0))

        harness.textView.insertNewline(nil)

        #expect(harness.textView.string == "a\n\nb\nc")
        #expect(harness.storage.markdown == "a\n\nb\nc")
    }

    @Test("removing the last newline resets the convention to LF")
    func removingLastNewline() {
        let harness = EditorHarness(markdown: "a\r\nb", documentId: "remove-last")
        harness.textView.insertText("", replacementRange: NSRange(location: 1, length: 2))
        #expect(harness.storage.markdown == "ab")
        harness.textView.setSelectedRange(NSRange(location: 1, length: 0))

        harness.textView.insertNewline(nil)

        #expect(harness.textView.string == "a\nb")
        #expect(harness.storage.markdown == "a\nb")
    }

    @Test("a queued editor write cannot undo an authoritative replacement")
    func queuedWriteDoesNotResurrect() async {
        let harness = EditorHarness(markdown: "local", documentId: "queued-write")
        harness.textView.insertText(
            "!",
            replacementRange: NSRange(location: 5, length: 0)
        )
        #expect(harness.storage.markdown == "local!")

        harness.storage.markdown = "external\n"
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }

        #expect(harness.textView.string == "external\n")
        #expect(harness.storage.markdown == "external\n")
    }
}
