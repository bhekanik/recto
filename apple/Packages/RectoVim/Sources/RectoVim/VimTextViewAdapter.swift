#if canImport(AppKit)
import AppKit
import os

/// Binds `VimEngine` to an `NSTextView`.
///
/// TextKit 2 only: nothing here touches `layoutManager`, because reading it
/// silently drops the view back to TextKit 1. Geometry goes through
/// `NSTextLayoutManager` and `NSTextLayoutFragment`.
///
/// The direction of travel matters. JS owns a mirror of the document and answers
/// the vim core's reads locally; a keystroke is one call in and one JSON payload
/// out, and Swift *replays the edit journal* rather than pushing text in. That
/// is the whole performance story — see `apple/Packages/README.md`.
@MainActor
public final class VimTextViewAdapter: NSObject, VimGeometryProvider, VimHistoryProvider {
    public let engine: VimEngine
    public let host: VimHost
    private unowned let textView: NSTextView

    /// Mode, pending keys, prompt and messages, for the status bar.
    public var onStatusChange: ((VimStatus) -> Void)?

    /// True while we are writing into the storage ourselves, so the text view's
    /// own change notifications do not bounce back into JS as external edits.
    private var applyingEdits = false

    private static let log = Logger(subsystem: "com.bhekani.recto", category: "RectoVim")

    public init(textView: NSTextView, engine: VimEngine, host: VimHost) {
        self.textView = textView
        self.engine = engine
        self.host = host
        super.init()
        host.geometryProvider = self
        host.historyProvider = self
    }

    public func start() throws {
        // Vim's undo granularity is one command, not one run-loop pass. Left on,
        // `groupsByEvent` also swallows every edit into a single group when no
        // run loop is turning — exactly the headless case the adapter tests run
        // in, where one `u` undid the whole session.
        textView.undoManager?.groupsByEvent = false
        try engine.start(text: textView.string)
        try apply(engine.state())
    }

    /// Returns true when vim consumed the key, in which case the text view must
    /// not also handle it.
    public func handle(_ event: NSEvent) -> Bool {
        guard let (key, modifiers) = VimKeyEvent.translate(event) else { return false }
        return handle(key: key, modifiers: modifiers)
    }

    /// One key by DOM name, for callers that already have one — the keystroke
    /// suite, a menu item, a synthesised key from a macro.
    @discardableResult
    public func handle(key: String, modifiers: VimModifiers = []) -> Bool {
        // Command chords belong to the menu bar, never to vim.
        if modifiers.contains(.command) { return false }
        do {
            let result = try engine.handleKey(key, modifiers: modifiers)
            try apply(result)
            return result.handled
        } catch {
            Self.log.error("handleKey failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Place the caret and let the text view follow. `column` is UTF-16.
    public func setCursor(line: Int, column: Int) throws {
        try apply(engine.setCursor(line: line, column: column))
    }

    /// Push the host's text into JS after an edit vim did not make.
    ///
    /// The selection is clamped on the way in because it is of *native* origin —
    /// a click can land mid-cluster where the engine's own offsets never do.
    public func syncFromTextView() throws {
        guard !applyingEdits else { return }
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        try apply(
            engine.setText(
                textView.string,
                anchor: selection.location,
                head: NSMaxRange(selection)))
    }

    // MARK: - Applying results

    private func apply(_ result: VimResult) throws {
        if !result.edits.isEmpty && !result.resynced {
            applyEdits(result.edits)
        }
        applySelection(result)
        applyCaretShape(result)
        if let scroll = result.scroll { applyScroll(scroll) }
        onStatusChange?(VimStatus(result: result))
    }

    /// Replay the edit journal onto the text storage, in order.
    ///
    /// Each edit goes through `shouldChangeText`/`didChangeText` rather than
    /// straight into the storage: that is what registers the change with the
    /// undo manager. Mutating `textStorage` directly is invisible to undo, which
    /// made `u` silently do nothing until the text-view proof caught it. One
    /// undo group around the batch keeps a keystroke to a single undo step, so
    /// `3dd` is undone in one go rather than three.
    ///
    /// Ranges are applied verbatim. They came out of the JS mirror, which has
    /// already snapped them to grapheme boundaries, and re-clamping here against
    /// ICU could disagree by a code unit and desynchronise the two buffers.
    /// `assertClampIsIdentity` states that invariant where a debug build checks it.
    private func applyEdits(_ edits: [VimEdit]) {
        guard let storage = textView.textStorage else { return }
        applyingEdits = true
        defer { applyingEdits = false }

        let undoManager = textView.undoManager
        undoManager?.beginUndoGrouping()
        for edit in edits {
            assertClampIsIdentity(edit.range, "edit")
            // JS offsets are UTF-16 code units and so is NSRange, so this is a
            // straight handover — the reason the adapter works in offsets rather
            // than in (line, column) pairs.
            guard textView.shouldChangeText(in: edit.range, replacementString: edit.insert)
            else { continue }
            storage.replaceCharacters(in: edit.range, with: edit.insert)
            textView.didChangeText()
        }
        undoManager?.endUndoGrouping()
        // NSTextView coalesces consecutive typing into one undo group, which
        // would make a single `u` throw away a whole editing session.
        textView.breakUndoCoalescing()
    }

    private func applySelection(_ result: VimResult) {
        let length = (textView.string as NSString).length
        var range = result.primarySelection.range
        // In normal mode vim's caret sits *on* a character; a zero-width
        // selection would draw as an insertion bar, so the shape carries the
        // mode instead (see `applyCaretShape`).
        range.location = min(range.location, length)
        range.length = min(range.length, length - range.location)
        assertClampIsIdentity(range, "selection")
        textView.setSelectedRange(range)
    }

    /// Debug-only check that the JS mirror and ICU agree about cluster
    /// boundaries. A disagreement is a real bug — the two buffers would drift —
    /// and it must be found here rather than as mangled text weeks later.
    private func assertClampIsIdentity(_ range: NSRange, _ what: String) {
        #if DEBUG
        let string = textView.string as NSString
        let clamped = GraphemeClamp.range(in: string, range)
        assert(
            clamped == range,
            "vim produced a \(what) range \(range) that is not on a grapheme boundary "
                + "(ICU would widen it to \(clamped)) — src/grapheme.js and ICU disagree")
        #endif
    }

    private func applyCaretShape(_ result: VimResult) {
        switch VimCaretShape(mode: result.mode) {
        case .bar:
            blockCaretWidth = nil
        case .block, .hollow:
            // AppKit has no block-cursor setting, so normal mode draws its own
            // by widening the insertion-point rect (see BlockCaretTextView).
            blockCaretWidth = characterWidthAtCaret()
        }
        textView.insertionPointColor = .textColor
        (textView as? BlockCaretTextView)?.blockCaretWidth = blockCaretWidth
    }

    private var blockCaretWidth: CGFloat?

    private func characterWidthAtCaret() -> CGFloat {
        let font = textView.font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        return ("m" as NSString).size(withAttributes: [.font: font]).width
    }

    private func applyScroll(_ scroll: VimScrollRequest) {
        switch scroll.kind {
        case "scrollIntoView":
            if let offset = scroll.offset {
                textView.scrollRangeToVisible(NSRange(location: offset, length: 0))
            } else {
                textView.scrollRangeToVisible(textView.selectedRange())
            }
        case "scrollTo":
            if let y = scroll.y {
                textView.enclosingScrollView?.contentView.scroll(to: NSPoint(x: 0, y: y))
            }
        default:
            break
        }
    }

    // MARK: - VimGeometryProvider

    public func lineHeight() -> Double {
        let font = textView.font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        return Double(font.ascender - font.descender + font.leading)
    }

    public func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double) {
        guard let rect = lineFragmentRect(at: offset) else { return (0, 0, lineHeight()) }
        return (Double(rect.minX), Double(rect.minY), Double(rect.maxY))
    }

    public func offsetAtCoords(left: Double, top: Double) -> Int {
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let fragment = layoutManager.textLayoutFragment(for: CGPoint(x: left, y: top))
        else { return 0 }
        return contentManager.offset(
            from: contentManager.documentRange.location,
            to: fragment.rangeInElement.location)
    }

    public func scrollInfo() -> (top: Double, height: Double, clientHeight: Double) {
        guard let scrollView = textView.enclosingScrollView else {
            return (0, Double(textView.bounds.height), Double(textView.bounds.height))
        }
        return (
            Double(scrollView.contentView.bounds.origin.y),
            Double(textView.bounds.height),
            Double(scrollView.contentView.bounds.height)
        )
    }

    /// `j`/`k` over **display** lines, which is what soft wrapping needs.
    ///
    /// Without this JS falls back to document lines, so a wrapped paragraph is
    /// one `j` tall — visibly wrong with wrapping on, which is our default.
    /// TextKit 2 has no "line fragment at index" call, so this walks the
    /// `NSTextLineFragment`s inside each layout fragment.
    ///
    /// All the index arithmetic stays in one coordinate system: an
    /// `NSTextLineFragment` indexes and positions characters relative to its
    /// *paragraph*, so `goal` is an x within the line fragment and never has to
    /// be converted into container coordinates.
    ///
    /// Returning nil hands the move back to JS's document-line fallback, which
    /// is the right answer for `page` moves — vim sizes those from the viewport
    /// and the core already has that from `scrollInfo`.
    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        guard unit == "line", amount != 0, let current = displayLine(containing: offset)
        else { return nil }

        let goal = goalColumn.map { CGFloat($0) } ?? current.x(of: offset)
        var line = current
        var hitSide = false
        for _ in 0..<abs(amount) {
            guard let next = displayLine(adjacentTo: line, forward: amount > 0) else {
                hitSide = true
                break
            }
            line = next
        }
        return (line.offset(atX: goal), hitSide)
    }

    /// One laid-out display line, plus everything needed to map offsets on it.
    private struct DisplayLine {
        let fragment: NSTextLayoutFragment
        let index: Int
        /// Document offset of the paragraph this line belongs to.
        let paragraphStart: Int

        var line: NSTextLineFragment { fragment.textLineFragments[index] }

        /// Frame in container coordinates, for `charCoords`.
        var frame: CGRect {
            line.typographicBounds.offsetBy(
                dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY)
        }

        func x(of documentOffset: Int) -> CGFloat {
            line.locationForCharacter(at: documentOffset - paragraphStart).x
        }

        func offset(atX x: CGFloat) -> Int {
            let point = CGPoint(x: x, y: line.typographicBounds.height / 2)
            return paragraphStart + line.characterIndex(for: point)
        }
    }

    private func displayLine(containing offset: Int) -> DisplayLine? {
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let location = contentManager.location(
                contentManager.documentRange.location, offsetBy: offset),
            let fragment = layoutManager.textLayoutFragment(for: location)
        else { return nil }
        let paragraphStart = contentManager.offset(
            from: contentManager.documentRange.location, to: fragment.rangeInElement.location)
        for (index, line) in fragment.textLineFragments.enumerated() {
            let lower = paragraphStart + line.characterRange.location
            if offset >= lower && offset <= lower + line.characterRange.length {
                return DisplayLine(
                    fragment: fragment, index: index, paragraphStart: paragraphStart)
            }
        }
        return nil
    }

    private func displayLine(adjacentTo line: DisplayLine, forward: Bool) -> DisplayLine? {
        let next = line.index + (forward ? 1 : -1)
        if next >= 0 && next < line.fragment.textLineFragments.count {
            return DisplayLine(
                fragment: line.fragment, index: next, paragraphStart: line.paragraphStart)
        }
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let sibling = forward
                ? layoutManager.textLayoutFragment(for: line.fragment.rangeInElement.endLocation)
                : previousFragment(before: line.fragment),
            sibling !== line.fragment, !sibling.textLineFragments.isEmpty
        else { return nil }
        return DisplayLine(
            fragment: sibling,
            index: forward ? 0 : sibling.textLineFragments.count - 1,
            paragraphStart: contentManager.offset(
                from: contentManager.documentRange.location, to: sibling.rangeInElement.location))
    }

    private func previousFragment(before fragment: NSTextLayoutFragment) -> NSTextLayoutFragment? {
        guard let layoutManager = textView.textLayoutManager else { return nil }
        var previous: NSTextLayoutFragment?
        layoutManager.enumerateTextLayoutFragments(
            from: fragment.rangeInElement.location, options: [.reverse, .ensuresLayout]
        ) { candidate in
            if candidate !== fragment {
                previous = candidate
                return false
            }
            return true
        }
        return previous
    }

    private func lineFragmentRect(at offset: Int) -> CGRect? {
        displayLine(containing: offset)?.frame
    }

    // MARK: - VimHistoryProvider

    /// `u` / `<C-r>`.
    ///
    /// The host owns undo, exactly as `u` is remapped to the document's undo
    /// tree on the web, so the engine never runs vim's own history. This routes
    /// to the text view's undo manager; the product routes to `RectoHistory`,
    /// which is why this is a protocol rather than a direct call.
    ///
    /// **Known gap for the undo tree**: vim puts the caret at the *start of the
    /// restored change*, while `NSUndoManager` restores whatever selection it
    /// recorded. The undo tree must compute a vim-shaped caret from the patch it
    /// applied rather than read it back off the text view.
    public func performHistory(_ kind: String) -> (text: String, anchor: Int, head: Int)? {
        guard let undoManager = textView.undoManager else { return nil }
        applyingEdits = true
        defer { applyingEdits = false }

        if kind == "undo" {
            guard undoManager.canUndo else { return nil }
            undoManager.undo()
        } else {
            guard undoManager.canRedo else { return nil }
            undoManager.redo()
        }
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        return (textView.string, selection.location, NSMaxRange(selection))
    }
}
#endif
