#if canImport(AppKit)
import AppKit

/// `NSTextView` with a vim block caret and a key hook.
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

    public override func keyDown(with event: NSEvent) {
        // Vim first; anything it declines falls through to the text view, which
        // is what keeps system editing behaviour (and IME) working when the vim
        // layer is idle or in insert mode.
        if keyHook?(event) == true { return }
        super.keyDown(with: event)
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
