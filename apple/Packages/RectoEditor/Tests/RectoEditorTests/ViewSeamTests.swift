//
//  ViewSeamTests.swift
//  RectoEditorTests
//
//  A document can be open in several windows, and find, a vim key layer,
//  typewriter scrolling and focus dimming all act on the window the reader is
//  in. A seam that resolves to "whichever view attached last" sends all four to
//  the wrong window.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
@Suite("View-scoped seam")
struct ViewSeamTests {

    /// Two views of one document, the way two windows would be.
    private func twoViews(_ markdown: String) -> (RectoTextStorage, NSTextView, NSTextView) {
        _ = NSApplication.shared
        let storage = RectoTextStorage(documentId: "seam", markdown: markdown)
        let styler = MarkdownStyler(presentation: .rich, theme: .twilight)

        func addView() -> NSTextView {
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
            return view
        }
        return (storage, addView(), addView())
    }

    @Test("a bound handle answers for its own view, not the most recent one")
    func boundHandleTargetsItsOwnView() {
        let (storage, first, second) = twoViews("alpha bravo charlie\n")

        #expect(storage.textView(for: first).nsTextView === first)
        #expect(storage.textView(for: second).nsTextView === second)
        // The unbound handle resolves to the most recent attachment, which is
        // exactly the behaviour a bound one exists to avoid.
        #expect(storage.textView.nsTextView === second)
    }

    @Test("selection through a bound handle lands in that view only")
    func selectionIsPerView() {
        let (storage, first, second) = twoViews("alpha bravo charlie\n")

        storage.textView(for: first).selectedRange = NSRange(location: 2, length: 3)
        storage.textView(for: second).selectedRange = NSRange(location: 12, length: 4)

        #expect(first.selectedRange() == NSRange(location: 2, length: 3))
        #expect(second.selectedRange() == NSRange(location: 12, length: 4))
        #expect(storage.textView(for: first).selectedRange == NSRange(location: 2, length: 3))
    }

    @Test("each handle reports its own view's layout manager, and one shared storage")
    func layoutIsPerViewAndStorageIsShared() {
        let (storage, first, second) = twoViews("alpha\n")

        let firstHandle = storage.textView(for: first)
        let secondHandle = storage.textView(for: second)

        #expect(firstHandle.textLayoutManager === first.textLayoutManager)
        #expect(secondHandle.textLayoutManager === second.textLayoutManager)
        #expect(firstHandle.textLayoutManager !== secondHandle.textLayoutManager)
        #expect(firstHandle.textContentStorage === secondHandle.textContentStorage,
                "one document must mean one content storage")
        #expect(firstHandle.allTextViews.count == 2)
    }

    @Test("the caret rect follows the handle's own view")
    func caretRectIsPerView() {
        let (storage, first, second) = twoViews("alpha bravo charlie delta echo\n")
        storage.textView(for: first).selectedRange = NSRange(location: 0, length: 0)
        storage.textView(for: second).selectedRange = NSRange(location: 25, length: 0)

        #expect(storage.textView(for: first).caretRect() != nil)
        #expect(storage.textView(for: second).caretRect() != nil)
    }
}
