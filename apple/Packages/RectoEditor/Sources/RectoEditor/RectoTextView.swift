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
/// A storage drives exactly one editor view, so there is nothing to
/// disambiguate: find, a vim key layer, typewriter scrolling and focus dimming
/// all act on this one. A second window on the same document is a second
/// ``RectoTextStorage`` with a seam of its own — see that type for how the two
/// are kept in step.
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
    public var scrollView: NSScrollView? { nsTextView?.enclosingScrollView }

    /// TextKit 2 layout manager. `layoutManager` (TextKit 1) is never used and
    /// touching it would silently drop the whole editor into compatibility
    /// mode.
    public var textLayoutManager: NSTextLayoutManager? {
        nsTextView?.textLayoutManager
    }

    /// The document's `NSTextContentStorage`, owned by the controller rather
    /// than auto-created by the view.
    public var textContentStorage: NSTextContentStorage { controller.textContentStorage }

    /// Selection in UTF-16 display coordinates.
    public var selectedRange: NSRange {
        get { nsTextView?.selectedRange() ?? NSRange(location: 0, length: 0) }
        nonmutating set { nsTextView?.setSelectedRange(newValue) }
    }

    /// The document text as the editor currently holds it.
    public var text: String { nsTextView?.string ?? "" }

    /// The text exposed by this presentation and its UTF-16 source mapping.
    /// Rich and preview omit hidden Markdown syntax; raw is an identity map.
    public var textProjection: MarkdownTextProjection { controller.textProjection }

    /// `true` while an editor is on screen.
    public var isAttached: Bool { nsTextView != nil }

    /// Apply an edit through the engine's own edit path: incremental restyle,
    /// caret preserved, reported through `onEdit`.
    @discardableResult
    public func applyPatch(
        _ patch: MarkdownTextPatch,
        actionName: String? = nil,
        registersUndo: Bool = false
    ) -> Bool {
        controller.applyPatch(range: patch.range, replacement: patch.replacement,
                              actionName: actionName,
                              registersUndo: registersUndo)
    }

    /// Apply source-coordinate patches as one editor operation.
    @discardableResult
    public func applyPatches(
        _ patches: [MarkdownTextPatch],
        actionName: String? = nil,
        registersUndo: Bool = false
    ) -> Bool {
        controller.applyPatches(
            patches,
            actionName: actionName,
            registersUndo: registersUndo
        )
    }

    /// Reveal or center a UTF-16 display range through TextKit 2 fragment
    /// geometry. Returns `false` while the editor is detached or for an invalid
    /// range.
    @discardableResult
    public func scroll(
        range: NSRange,
        position: MarkdownScrollPosition = .nearest
    ) -> Bool {
        controller.scroll(range: range, position: position)
    }

    /// Set the clip origin through the engine's clamp/restore-cancel path.
    @discardableResult
    public func scroll(toVerticalOffset y: CGFloat) -> Bool {
        controller.scroll(toVerticalOffset: y)
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
        var rect: CGRect?
        layoutManager.enumerateTextSegments(
            in: NSTextRange(location: location),
            type: .standard,
            options: [.rangeNotRequired]
        ) { _, segmentFrame, _, _ in
            rect = segmentFrame
            return false
        }
        guard var rect else { return nil }
        let origin = textView.textContainerOrigin
        rect.origin.x += origin.x
        rect.origin.y += origin.y
        return rect
    }

    /// Bring the editor to `text` through the engine's own edit path: one
    /// patch for the changed run, caret transformed through it, one `onEdit`.
    /// Never assigns `NSTextView.string`.
    @discardableResult
    public func applyText(_ text: String) -> Bool {
        controller.applyText(text)
    }

    /// How the insertion point is drawn. A modal key layer sets `.block` for
    /// normal mode and `.bar` for insert mode.
    public var caretShape: MarkdownCaretShape {
        get { controller.caretShape }
        nonmutating set { controller.caretShape = newValue }
    }

    func installTextFinderResponder(_ responder: any MarkdownTextFinderActionResponder) {
        controller.textFinderActionResponder = responder
    }

    func removeTextFinderResponder(_ responder: any MarkdownTextFinderActionResponder) {
        guard controller.textFinderActionResponder === responder else { return }
        controller.textFinderActionResponder = nil
    }

    func installKeyInterceptor(_ interceptor: any MarkdownKeyInterceptor) {
        controller.keyInterceptor = interceptor
    }

    func removeKeyInterceptor(_ interceptor: any MarkdownKeyInterceptor) {
        guard controller.keyInterceptor === interceptor else { return }
        controller.keyInterceptor = nil
    }

    func rects(forSourceRange range: NSRange) -> [CGRect] {
        guard range.length > 0,
              let textView = nsTextView,
              let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let start = contentManager.location(
                contentManager.documentRange.location,
                offsetBy: range.location
              ),
              let end = contentManager.location(start, offsetBy: range.length),
              let textRange = NSTextRange(location: start, end: end)
        else { return [] }

        let origin = textView.textContainerOrigin
        var rects: [CGRect] = []
        layoutManager.enumerateTextSegments(
            in: textRange,
            type: .selection,
            options: []
        ) { _, rect, _, _ in
            rects.append(rect.offsetBy(dx: origin.x, dy: origin.y))
            return true
        }
        return rects
    }
}
