import AppKit
import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@Suite("Line-ending policy", .serialized)
@MainActor
struct LineEndingPolicyTests {
    @Test("a programmatic patch carrying a bare LF into a CRLF document lands once",
          arguments: [Presentation.raw, .rich])
    func programmaticBareLFLandsOnce(presentation: Presentation) throws {
        // The engine reports a programmatic patch twice: once inside its
        // mutation transaction (where the storage's normalising applyText is
        // refused as re-entrant) and once after it. The second report used to
        // be applied to the already-normalised markdown, so the text landed
        // twice.
        // A mounted RectoEditorView, not EditorHarness: the second report is
        // the view's text-change observer, which only exists on screen.
        let storage = RectoTextStorage(documentId: "lf-once", markdown: "alpha\r\nbeta\r\n")
        var edits: [RectoEditorEdit] = []
        let harness = WindowHarness(
            RectoEditorView(storage: storage,
                            styler: MarkdownStyler(presentation: presentation, theme: .twilight),
                            onEdit: { edits.append($0) }),
            size: CGSize(width: 640, height: 320))
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)

        #expect(storage.textView.applyPatch(MarkdownTextPatch(
            range: NSRange(location: 11, length: 0), replacement: "\nfoo\r")))

        #expect(Array(storage.markdown.utf16) == Array("alpha\r\nbeta\r\nfoo\r\n\r\n".utf16))
        #expect(Array(textView.string.utf16) == Array(storage.markdown.utf16))
        #expect(edits.count == 1)
    }

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
