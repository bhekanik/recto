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

    /// The text view changed its own storage, and who did it.
    ///
    /// AppKit owns the storage during a composition and modelling that as vim
    /// edits would fight the input system, so the adapter stands aside and takes
    /// the storage back afterwards. Hooking *any* change rather than
    /// composition-end specifically is what makes that reliable: Backspace on a
    /// marked run can end the composition itself, so there is no later
    /// `unmarkText` to hang the resync on.
    ///
    /// The source matters because the two changes need opposite treatment — see
    /// `VimTextChangeSource`.
    ///
    /// The adapter ignores this while it is applying its own edits.
    public var textDidChangeExternally: ((VimTextChangeSource) -> Void)?

    /// A change the vim layer did not make is about to be registered with the
    /// undo manager.
    ///
    /// This has to be *before* the mutation, not after it. `didChangeText` runs
    /// once AppKit has already registered the external undo action, and if the
    /// vim insert group is still open that action lands inside it: typing `iab`
    /// and then letting something else insert `Z` made one `u` undo `Z` and `ab`
    /// together.
    public var willChangeTextExternally: (() -> Void)?

    /// The text view moved the caret itself — an arrow key insert mode declines
    /// to AppKit, Home/End, a click, a menu command.
    ///
    /// Without this the engine never learns: `iab<Left>` moved the selection to
    /// offset 1 and left the engine at 2, so the next character was inserted in
    /// the wrong place.
    public var selectionDidChangeExternally: (() -> Void)?

    /// Set for the duration of a change the input system owns, so
    /// `shouldChangeText` can tell a composition from an outside edit *before*
    /// the mutation happens. Cleared at each `didChangeText`, and by the
    /// overrides below once `super` has returned.
    private var pendingChangeSource: VimTextChangeSource?

    public override func keyDown(with event: NSEvent) {
        // **Composition wins.** While marked text is up, Space, Return, Escape
        // and Backspace belong to the input manager — they select a candidate,
        // commit, cancel, or delete a jamo. Handing them to vim first stops the
        // composition from ever committing and leaves the storage holding text
        // the mirror never saw: a marked `ni` followed by Space produced storage
        // `" niab"` against mirror `" ab"`.
        if hasMarkedText() {
            super.keyDown(with: event)
            return
        }
        // Otherwise vim first; anything it declines falls through to the text
        // view, which is what keeps system editing behaviour working when the
        // vim layer is idle or in insert mode.
        if keyHook?(event) == true { return }
        super.keyDown(with: event)
    }

    public override func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String)
        // A commit that ends a composition is AppKit's to apply; the resync in
        // `didChangeText` picks it up.
        if let text, !hasMarkedText(), inputHook?(text, replacementRange) == true {
            return
        }
        if hasMarkedText() { pendingChangeSource = .composition }
        super.insertText(string, replacementRange: replacementRange)
        pendingChangeSource = nil
    }

    public override func setMarkedText(
        _ string: Any, selectedRange: NSRange, replacementRange: NSRange
    ) {
        pendingChangeSource = .composition
        super.setMarkedText(
            string, selectedRange: selectedRange, replacementRange: replacementRange)
        pendingChangeSource = nil
    }

    public override func unmarkText() {
        pendingChangeSource = .composition
        super.unmarkText()
        pendingChangeSource = nil
    }

    public override func shouldChangeText(
        in affectedCharRange: NSRange, replacementString: String?
    ) -> Bool {
        // Whoever is about to mutate the storage has not said who they are, so
        // they are not the input system: give the adapter its chance to close
        // the vim undo group before the mutation registers one of its own.
        if pendingChangeSource == nil {
            pendingChangeSource = .external
            willChangeTextExternally?()
        }
        return super.shouldChangeText(
            in: affectedCharRange, replacementString: replacementString)
    }

    public override func didChangeText() {
        let source = pendingChangeSource ?? .external
        pendingChangeSource = nil
        super.didChangeText()
        textDidChangeExternally?(source)
    }

    /// The primitive every selection change funnels through, including the
    /// arrow keys AppKit handles when insert mode declines them and the click
    /// that placed the caret.
    public override func setSelectedRanges(
        _ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool
    ) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        // Mid-drag the selection is not settled yet, and the engine has no use
        // for the intermediate ranges. Nor for the ones AppKit produces in the
        // middle of a change it is already going to report: the caret that
        // matters is the one the change leaves behind.
        guard !stillSelecting, pendingChangeSource == nil else { return }
        selectionDidChangeExternally?()
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
