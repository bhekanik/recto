//
//  RectoTextView.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// The AppKit seam: everything the app needs to reach past SwiftUI into the
/// live text view, in one place.
///
/// The engine builds and owns the `NSTextView` (it needs its own TextKit 2
/// stack, layout-fragment subclass and scroll container), so this is a facade
/// over `MarkdownEditorController` rather than an `NSTextView` subclass.
/// Everything stage 2 needs a text view for goes through here, so there is one
/// place to look when the engine's ownership changes.
///
/// Every member is inert while nothing is attached — an editor that has been
/// scrolled out of existence answers `nil`/`false` rather than trapping.
@MainActor
public struct RectoTextView {
    private let controller: MarkdownEditorController

    init(controller: MarkdownEditorController) {
        self.controller = controller
    }

    /// The live text view, or `nil` when no editor is on screen.
    ///
    /// Used for: `NSTextFinder` (as `client`, with the scroll view as
    /// `findBarContainer`), a `keyDown` layer for vim, typewriter scrolling off
    /// `textLayoutManager`, and the system text affordances — Writing Tools,
    /// dictation, Speak, Look Up, Services — which need nothing more than for
    /// this to be a real `NSTextView`.
    public var nsTextView: NSTextView? { controller.textView }

    /// The scroll view the editor lives in — the `NSTextFinderBarContainer`,
    /// and what typewriter scrolling drives.
    public var scrollView: NSScrollView? { controller.textView?.enclosingScrollView }

    /// TextKit 2 layout manager. `layoutManager` (TextKit 1) is never used and
    /// touching it would silently drop the whole editor into compatibility
    /// mode.
    public var textLayoutManager: NSTextLayoutManager? {
        controller.textView?.textLayoutManager
    }

    /// One `NSTextContentStorage` per document.
    public var textContentStorage: NSTextContentStorage? {
        controller.textView?.textContentStorage
    }

    /// Selection in UTF-16 display coordinates.
    public var selectedRange: NSRange {
        get { controller.selectedRange }
        nonmutating set { controller.selectedRange = newValue }
    }

    /// The document text as the editor currently holds it.
    public var text: String { controller.text }

    /// `true` while an editor is on screen.
    public var isAttached: Bool { controller.isAttached }

    /// Apply an edit through the engine's own edit path: incremental restyle,
    /// caret preserved, reported through `onEdit`.
    @discardableResult
    public func applyPatch(_ patch: MarkdownTextPatch, registersUndo: Bool = false) -> Bool {
        controller.applyPatch(range: patch.range, replacement: patch.replacement,
                              registersUndo: registersUndo)
    }

    /// Make the editor first responder.
    @discardableResult
    public func focus() -> Bool {
        guard let textView = controller.textView, let window = textView.window else { return false }
        return window.makeFirstResponder(textView)
    }

    /// The caret's rect in the scroll view's document coordinates, for anything
    /// that follows the caret (the slash menu, the format bar, an AI popover).
    public func caretRect() -> CGRect? {
        guard let textView = controller.textView,
              let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let location = contentManager.location(
                contentManager.documentRange.location,
                offsetBy: controller.selectedRange.location)
        else { return nil }
        guard let fragment = layoutManager.textLayoutFragment(for: location) else { return nil }
        var rect = fragment.layoutFragmentFrame
        let origin = textView.textContainerOrigin
        rect.origin.x += origin.x
        rect.origin.y += origin.y
        return rect
    }
}
