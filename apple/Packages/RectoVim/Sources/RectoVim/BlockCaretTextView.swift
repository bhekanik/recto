#if canImport(AppKit)
import AppKit

/// `NSTextView` with a vim block caret and the two hooks the adapter needs.
///
/// AppKit has no block-cursor setting, so normal mode draws its own by widening
/// the insertion-point rect to one character. `drawInsertionPoint` is the
/// supported seam for that and does not involve the layout manager, so TextKit 2
/// stays on.
public final class BlockCaretTextView: NSTextView {
    /// Non-nil in normal and visual mode; nil means the ordinary bar caret.
    public var blockCaretWidth: CGFloat? {
        didSet {
            guard blockCaretWidth != oldValue else { return }
            needsDisplay = true
        }
    }

    /// Returns true if the key was consumed by vim.
    public var keyHook: ((NSEvent) -> Bool)?

    /// Text the input system produced — a typed character, a composed dead key,
    /// an emoji from the picker, a committed IME string, a paste. Returns true
    /// if vim took it, in which case the text view must not insert it itself.
    ///
    /// This exists because a `keyDown` event carries one key name and real text
    /// input does not: NFD arrives as a base letter plus a combining mark, an
    /// emoji as several scalars, a dead key as a composition. Synthesising the
    /// insert from the key name loses all of it, and letting AppKit insert
    /// directly changes the storage without telling the JS mirror.
    public var inputHook: ((String, NSRange) -> Bool)?

    /// An IME composition finished. AppKit owns the storage while marked text is
    /// up, so the adapter resyncs rather than trying to model it.
    public var compositionDidEnd: (() -> Void)?

    public override func keyDown(with event: NSEvent) {
        // Vim first; anything it declines falls through to the text view, which
        // is what keeps system editing behaviour (and IME) working when the vim
        // layer is idle or in insert mode.
        if keyHook?(event) == true { return }
        super.keyDown(with: event)
    }

    public override func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String)
        // A commit that ends a composition is AppKit's to apply; the adapter
        // resyncs from the storage once it has.
        let wasComposing = hasMarkedText()
        if let text, !wasComposing, inputHook?(text, replacementRange) == true {
            return
        }
        super.insertText(string, replacementRange: replacementRange)
        if wasComposing, !hasMarkedText() { compositionDidEnd?() }
    }

    public override func unmarkText() {
        let wasComposing = hasMarkedText()
        super.unmarkText()
        if wasComposing { compositionDidEnd?() }
    }

    public override func drawInsertionPoint(
        in rect: NSRect, color: NSColor, turnedOn flag: Bool
    ) {
        guard let width = blockCaretWidth else {
            super.drawInsertionPoint(in: rect, color: color, turnedOn: flag)
            return
        }
        var blockRect = rect
        blockRect.size.width = width
        // Half alpha so the character under the caret stays readable, which is
        // what terminal vim gets for free by inverting the cell.
        super.drawInsertionPoint(
            in: blockRect, color: color.withAlphaComponent(0.45), turnedOn: flag
        )
    }

    public override func setNeedsDisplay(_ rect: NSRect, avoidAdditionalLayout flag: Bool) {
        // The insertion point rect is one point wide as far as AppKit knows, so
        // widen the invalidated area or the block caret leaves trails.
        var expanded = rect
        expanded.size.width += blockCaretWidth ?? 0
        super.setNeedsDisplay(expanded, avoidAdditionalLayout: flag)
    }
}
#endif
