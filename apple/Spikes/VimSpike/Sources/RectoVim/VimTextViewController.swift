#if canImport(AppKit)
import AppKit

/// Binds the vim engine to an `NSTextView`.
///
/// TextKit 2 only: nothing here touches `layoutManager`, because doing so
/// silently drops the view back to TextKit 1. Geometry goes through
/// `NSTextLayoutManager` / `NSTextLayoutFragment` instead.
@MainActor
public final class VimTextViewController: NSObject, VimGeometryProvider, VimHistoryProvider {
    public let engine: RectoVimEngine
    public let host: RectoVimHost
    private unowned let textView: NSTextView

    /// Mode and pending keys, for the status bar.
    public var onStatusChange: ((VimStatus) -> Void)?

    /// True while we are writing into the storage ourselves, so the text view's
    /// own change notifications do not bounce back into JS as external edits.
    private var applyingEdits = false

    public init(textView: NSTextView, engine: RectoVimEngine, host: RectoVimHost) {
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
        // run loop is turning — which is exactly the headless case the
        // text-view proof runs in, where one `u` undid the whole session.
        textView.undoManager?.groupsByEvent = false
        try engine.start(text: textView.string)
        try apply(engine.state())
    }

    /// Returns true when vim consumed the key, in which case the text view must
    /// not also handle it.
    public func handle(_ event: NSEvent) -> Bool {
        guard let (key, mods) = VimKeyEvent.translate(event) else { return false }
        // Command chords belong to the menu bar, never to vim.
        if mods.contains(.command) { return false }
        do {
            let result = try engine.handleKey(key, mods: mods)
            try apply(result)
            return result.handled
        } catch {
            NSLog("RectoVim: %@", String(describing: error))
            return false
        }
    }

    /// Push the host's text into JS after an edit vim did not make.
    public func syncFromTextView() throws {
        guard !applyingEdits else { return }
        let sel = textView.selectedRange()
        try apply(engine.setText(
            textView.string,
            anchor: sel.location,
            head: sel.location + sel.length
        ))
    }

    // MARK: - applying results

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
    /// text view's undo manager. Mutating `textStorage` directly is invisible to
    /// undo, which made `u` silently do nothing until the text-view proof caught
    /// it. One undo group around the batch keeps a keystroke to a single undo
    /// step, so `3dd` is undone in one go rather than three.
    private func applyEdits(_ edits: [VimEdit]) {
        guard let storage = textView.textStorage else { return }
        applyingEdits = true
        defer { applyingEdits = false }

        let undoManager = textView.undoManager
        undoManager?.beginUndoGrouping()
        for edit in edits {
            // JS offsets are UTF-16 code units and so is NSRange, so this is a
            // straight handover with no conversion — the reason the adapter
            // works in offsets rather than in (line, column) pairs.
            guard textView.shouldChangeText(in: edit.range, replacementString: edit.insert)
            else { continue }
            storage.replaceCharacters(in: edit.range, with: edit.insert)
            textView.didChangeText()
        }
        undoManager?.endUndoGrouping()
        // NSTextView coalesces consecutive typing into one undo group, which
        // would make a single `u` throw away a whole editing session. Vim's
        // undo granularity is one command, so end the run explicitly.
        textView.breakUndoCoalescing()
    }

    private func applySelection(_ result: VimResult) {
        let selection = result.primarySelection
        let length = (textView.string as NSString).length
        var range = selection.range
        // In normal mode vim's caret sits *on* a character; a zero-width
        // selection would draw as an insertion bar. The block caret is drawn in
        // `applyCaretShape` instead, so keep the range empty here and let the
        // shape carry the mode.
        range.location = min(range.location, length)
        range.length = min(range.length, length - range.location)
        textView.setSelectedRange(range)
    }

    private func applyCaretShape(_ result: VimResult) {
        let shape = VimCaretShape(mode: result.mode)
        switch shape {
        case .bar:
            textView.insertionPointColor = .textColor
            blockCaretWidth = nil
        case .block, .hollow:
            textView.insertionPointColor = .textColor
            // A full-width block caret; NSTextView has no built-in block cursor,
            // so the app layer draws it (see BlockCaretTextView).
            blockCaretWidth = characterWidthAtCaret()
        }
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
        guard let rect = fragmentRect(at: offset) else { return (0, 0, lineHeight()) }
        return (Double(rect.minX), Double(rect.minY), Double(rect.maxY))
    }

    public func offsetAtCoords(left: Double, top: Double) -> Int {
        guard let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let fragment = layoutManager.textLayoutFragment(
                  for: CGPoint(x: left, y: top)
              )
        else { return 0 }
        return contentManager.offset(
            from: contentManager.documentRange.location,
            to: fragment.rangeInElement.location
        )
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

    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        // Left to the JS fallback (document lines) for the spike. Doing this
        // properly means walking NSTextLayoutFragment line fragments so that a
        // soft-wrapped paragraph counts as several rows; that is N5's job,
        // where the wrapping configuration is actually known.
        nil
    }

    private func fragmentRect(at offset: Int) -> CGRect? {
        guard let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let location = contentManager.location(
                  contentManager.documentRange.location, offsetBy: offset
              ),
              let fragment = layoutManager.textLayoutFragment(for: location)
        else { return nil }
        return fragment.layoutFragmentFrame
    }

    // MARK: - VimHistoryProvider

    /// `u` / `<C-r>`. The spike routes them to the text view's undo manager;
    /// the product routes them to the document's undo tree, which is why this
    /// is a protocol rather than a direct call.
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
        let selection = textView.selectedRange()
        return (textView.string, selection.location, selection.location + selection.length)
    }
}

public struct VimStatus: Sendable, Equatable {
    public let mode: String
    public let label: String
    public let pending: String
    public let prompt: String?
    public let message: String?

    init(result: VimResult) {
        mode = result.mode
        pending = result.pending
        if let prompt = result.prompt {
            self.prompt = prompt.prefix + prompt.value
        } else {
            prompt = nil
        }
        message = result.notification?.text
        switch result.mode {
        case "insert": label = "-- INSERT --"
        case "replace": label = "-- REPLACE --"
        case let m where m.hasPrefix("visual"):
            label = result.subMode == "linewise"
                ? "-- VISUAL LINE --"
                : (result.subMode == "blockwise" ? "-- VISUAL BLOCK --" : "-- VISUAL --")
        default: label = ""
        }
    }
}
#endif
