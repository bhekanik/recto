//
//  ExternalEditFeedTests.swift
//  RectoEditorTests
//
//  `onEdit` is the reader's input, and only the reader's. The undo tree and the
//  sync outbox both consume it, so a change that came from sync or from history
//  navigation coming back out of it is a duplicate undo entry or an echo loop.
//

import AppKit
import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("External edits never reach the edit feed")
struct ExternalEditFeedTests {

    private func harness(_ markdown: String) -> (EditorHarness, () -> [MarkdownTextMutation]) {
        let editor = EditorHarness(markdown: markdown)
        let recorder = Recorder()
        editor.storage.onEdit = { recorder.mutations.append($0) }
        return (editor, { recorder.mutations })
    }

    private final class Recorder {
        var mutations: [MarkdownTextMutation] = []
    }

    @Test("assigning markdown changes the editor and emits nothing")
    func assignmentEmitsNothing() {
        let (editor, recorded) = harness("alpha\n\nbravo\n\ncharlie\n")
        editor.textView.setSelectedRange(NSRange(location: 15, length: 0))

        editor.storage.markdown = "alpha\n\nBRAVO\n\ncharlie\n"

        #expect(editor.textView.string == "alpha\n\nBRAVO\n\ncharlie\n")
        #expect(editor.textView.selectedRange() == NSRange(location: 15, length: 0))
        #expect(recorded().isEmpty, "a sync assignment came back out of onEdit")
    }

    @Test("applying a patch changes the editor and emits nothing")
    func patchEmitsNothing() {
        let (editor, recorded) = harness("alpha bravo charlie\n")
        let range = (editor.storage.markdown as NSString).range(of: "bravo")

        #expect(editor.storage.apply(MarkdownTextPatch(range: range, replacement: "DELTA")))

        #expect(editor.textView.string == "alpha DELTA charlie\n")
        #expect(recorded().isEmpty, "an external patch came back out of onEdit")
    }

    @Test("what the reader types does reach the feed")
    func typingReachesTheFeed() {
        let (editor, recorded) = harness("alpha\n")
        editor.textView.setSelectedRange(NSRange(location: 5, length: 0))

        editor.textView.insertText("!", replacementRange: NSRange(location: 5, length: 0))

        #expect(recorded() == [MarkdownTextMutation(range: NSRange(location: 5, length: 0),
                                                    replacement: "!")])
    }

    @Test("the storage tracks what the reader typed without re-patching the editor")
    func typingUpdatesTheStorage() {
        let editor = EditorHarness(markdown: "alpha\n")
        editor.textView.setSelectedRange(NSRange(location: 5, length: 0))
        editor.textView.insertText("!", replacementRange: NSRange(location: 5, length: 0))
        editor.storage.editorDidWriteBack(editor.textView.string)

        #expect(editor.storage.markdown == "alpha!\n")
        #expect(editor.textView.string == "alpha!\n")
    }
}
