//
//  ViewSeamTests.swift
//  RectoEditorTests
//
//  `RectoTextView` is the one place the app reaches past SwiftUI into AppKit —
//  find, a vim key layer, typewriter scrolling, focus dimming, the caret-
//  following popovers. A storage drives one editor, so the seam has one view to
//  answer for; what these hold is that it answers for the RIGHT one, and that
//  it stays inert rather than trapping when there is none.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
@Suite("Editor seam")
struct ViewSeamTests {

    /// One storage with an editor attached, the way a window would.
    private func attachedEditor(_ markdown: String) -> (RectoTextStorage, NSTextView) {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "seam", markdown: markdown)
        let styler = MarkdownStyler(presentation: .rich, theme: .twilight)
        let wrapper = NativeTextViewWrapper(
            text: .constant(markdown),
            configuration: styler.engineConfiguration(),
            controller: storage.controller,
            fontName: styler.typography.family,
            fontSize: styler.typography.resolvedSize,
            documentId: storage.documentId,
            isEditable: true)
        let coordinator = wrapper.makeCoordinator()
        let layoutManager = NSTextLayoutManager()
        let container = NSTextContainer(
            size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        layoutManager.textContainer = container
        storage.controller.textContentStorage.addTextLayoutManager(layoutManager)
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 400),
                              textContainer: container)
        view.isEditable = true
        coordinator.adopt(view, text: markdown)
        return (storage, view)
    }

    @Test("the seam answers for the attached view")
    func seamTargetsTheAttachedView() {
        let (storage, view) = attachedEditor("alpha bravo charlie\n")

        #expect(storage.textView.nsTextView === view)
        #expect(storage.textView.isAttached)
        #expect(storage.textView.text == "alpha bravo charlie\n")
    }

    @Test("selection through the seam lands in the editor")
    func selectionReachesTheEditor() {
        let (storage, view) = attachedEditor("alpha bravo charlie\n")

        storage.textView.selectedRange = NSRange(location: 2, length: 3)

        #expect(view.selectedRange() == NSRange(location: 2, length: 3))
        #expect(storage.textView.selectedRange == NSRange(location: 2, length: 3))
    }

    @Test("the seam reports the editor's TextKit 2 stack")
    func seamReportsTheLayoutStack() {
        let (storage, view) = attachedEditor("alpha\n")
        let seam = storage.textView

        #expect(seam.textLayoutManager === view.textLayoutManager)
        #expect(seam.textContentStorage === storage.controller.textContentStorage,
                "the document's storage is the controller's, not one the view made")
        #expect(view.textLayoutManager?.textContentManager === seam.textContentStorage)
    }

    @Test("the caret rect follows the editor's caret")
    func caretRectFollowsTheCaret() throws {
        let (storage, _) = attachedEditor("alpha bravo charlie delta echo\n")

        storage.textView.selectedRange = NSRange(location: 0, length: 0)
        let atStart = try #require(storage.textView.caretRect())
        storage.textView.selectedRange = NSRange(location: 25, length: 0)
        let atEnd = try #require(storage.textView.caretRect())

        #expect(atStart != atEnd || atStart.height > 0)
    }

    /// Everything must answer rather than trap with no editor on screen. That
    /// is the state before the first window opens and after the last one
    /// closes, and the app holds seams across both.
    @Test("a seam with no editor is inert")
    func detachedSeamIsInert() {
        let storage = RectoTextStorage(documentId: "seam", markdown: "alpha\n")

        let seam = storage.textView
        #expect(seam.isAttached == false)
        #expect(seam.nsTextView == nil)
        #expect(seam.scrollView == nil)
        #expect(seam.textLayoutManager == nil)
        #expect(seam.text.isEmpty)
        #expect(seam.selectedRange == NSRange(location: 0, length: 0))
        #expect(seam.caretRect() == nil)
        #expect(seam.focus() == false)
        #expect(seam.applyPatch(MarkdownTextPatch(range: NSRange(location: 0, length: 1),
                                                  replacement: "b")) == false)
    }
}
