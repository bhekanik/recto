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
/// **Bind it to one view.** A document can be open in several windows, and
/// find, a vim key layer, typewriter scrolling and focus dimming all act on the
/// window the reader is in — not on whichever view happened to attach last.
/// `RectoEditorView` hands each of its instances its own handle through
/// `onAttach`; `storage.textView` (no argument) resolves to the most recently
/// attached view and is only right when the document has exactly one.
///
/// Every member is inert while nothing is attached — an editor that has been
/// scrolled out of existence answers `nil`/`false` rather than trapping.
@MainActor
public struct RectoTextView {
    private let controller: MarkdownEditorController
    /// The view this handle speaks for. `nil` means "whichever is current",
    /// which is what `storage.textView` gives you.
    private weak var boundView: NSTextView?

    init(controller: MarkdownEditorController, view: NSTextView? = nil) {
        self.controller = controller
        self.boundView = view
    }

    /// The live text view, or `nil` when no editor is on screen.
    ///
    /// Used for: `NSTextFinder` (as `client`, with the scroll view as
    /// `findBarContainer`), a `keyDown` layer for vim, typewriter scrolling off
    /// `textLayoutManager`, and the system text affordances — Writing Tools,
    /// dictation, Speak, Look Up, Services — which need nothing more than for
    /// this to be a real `NSTextView`.
    public var nsTextView: NSTextView? { boundView ?? controller.textView }

    /// Every view showing this document. `nsTextView` is one of them.
    public var allTextViews: [NSTextView] { controller.textViews }

    /// The scroll view the editor lives in — the `NSTextFinderBarContainer`,
    /// and what typewriter scrolling drives.
    public var scrollView: NSScrollView? { nsTextView?.enclosingScrollView }

    /// TextKit 2 layout manager. `layoutManager` (TextKit 1) is never used and
    /// touching it would silently drop the whole editor into compatibility
    /// mode.
    public var textLayoutManager: NSTextLayoutManager? {
        nsTextView?.textLayoutManager
    }

    /// One `NSTextContentStorage` per document.
    /// One per document, shared by every view of it.
    public var textContentStorage: NSTextContentStorage { controller.textContentStorage }

    /// Selection in UTF-16 display coordinates.
    /// This view's selection. Each window has its own.
    public var selectedRange: NSRange {
        get { nsTextView?.selectedRange() ?? NSRange(location: 0, length: 0) }
        nonmutating set { nsTextView?.setSelectedRange(newValue) }
    }

    /// The document text as the editor currently holds it.
    public var text: String { nsTextView?.string ?? "" }

    /// `true` while an editor is on screen.
    public var isAttached: Bool { nsTextView != nil }

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
        guard let textView = nsTextView, let window = textView.window else { return false }
        return window.makeFirstResponder(textView)
    }

    /// The caret's rect in the scroll view's document coordinates, for anything
    /// that follows the caret (the slash menu, the format bar, an AI popover).
    public func caretRect() -> CGRect? {
        guard let textView = nsTextView,
              let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let location = contentManager.location(
                contentManager.documentRange.location,
                offsetBy: textView.selectedRange().location)
        else { return nil }
        guard let fragment = layoutManager.textLayoutFragment(for: location) else { return nil }
        var rect = fragment.layoutFragmentFrame
        let origin = textView.textContainerOrigin
        rect.origin.x += origin.x
        rect.origin.y += origin.y
        return rect
    }
}
