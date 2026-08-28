#if canImport(UIKit)
import UIKit
import os

/// Binds `VimEngine` to a `UITextView`, for iPad and iPhone with a hardware
/// keyboard attached (plan 023 D-N6).
///
/// Same contract as `VimTextViewAdapter`: JS owns the mirror, Swift replays the
/// edit journal, offsets are UTF-16 code units, ranges coming out of the engine
/// are already on grapheme boundaries and are applied verbatim.
///
/// Two things differ from AppKit, both forced by UIKit:
///
/// - **Undo.** `UITextView` has no `shouldChangeText(in:replacementString:)`.
///   Edits go through `UITextInput.replace(_:withText:)`, which is the path the
///   keyboard itself uses and is therefore the one the undo manager observes.
///   Writing to `textStorage` directly is invisible to undo here too.
/// - **Caret shape.** There is no `drawInsertionPoint` seam. A block caret is an
///   overlay the app layer draws; this adapter reports the shape through
///   `onStatusChange` and leaves the drawing to the view, which is where the
///   design tokens live.
@MainActor
public final class VimUITextViewAdapter: NSObject, VimGeometryProvider, VimHistoryProvider {
    public let engine: VimEngine
    public let host: VimHost
    private unowned let textView: UITextView

    public var onStatusChange: ((VimStatus) -> Void)?

    /// Replay could not be completed and the engine has been resynced from the
    /// storage. Same contract as the AppKit adapter.
    public var onReplayFailure: ((VimReplayFailure) -> Void)?

    private var applyingEdits = false
    private static let log = Logger(subsystem: "com.bhekani.recto", category: "RectoVim")

    public init(textView: UITextView, engine: VimEngine, host: VimHost) {
        self.textView = textView
        self.engine = engine
        self.host = host
        super.init()
        host.geometryProvider = self
        host.historyProvider = self
    }

    public func start() throws {
        try engine.start(text: textView.text ?? "")
        // The text view's input system owns text input: it is the only thing
        // that sees NFD, dead keys, emoji and IME as what they are. UIKit has no
        // `BlockCaretTextView` equivalent to hook, so a `UITextView` subclass
        // must override `insertText(_:)` (and `UITextInput.replace(_:withText:)`
        // when it supports marked text) and forward to `insertText` below.
        engine.setExternalInput(true)
        try apply(engine.state())
    }

    /// Text the input system produced. Returns true when vim took it, in which
    /// case the caller must not insert it itself.
    @discardableResult
    public func insertText(
        _ text: String,
        replacementRange: NSRange = NSRange(location: NSNotFound, length: 0)
    ) -> Bool {
        // A commit that ends a composition is UIKit's to apply; the caller
        // resyncs afterwards, as `VimTextViewAdapter` does on AppKit.
        if textView.markedTextRange != nil { return false }
        do {
            let result: VimResult
            if replacementRange.location == NSNotFound {
                result = try engine.insertText(text)
            } else {
                result = try engine.insertText(
                    text, from: replacementRange.location,
                    to: NSMaxRange(replacementRange))
            }
            try apply(result)
            return result.handled
        } catch {
            Self.log.error("insertText failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Call from `pressesBegan`. Returns true when vim consumed the key, in
    /// which case the caller must not pass it to `super`.
    public func handle(_ press: UIPress) -> Bool {
        // Composition wins, same as AppKit: while marked text is up, Space,
        // Return, Escape and Backspace belong to the input system.
        if textView.markedTextRange != nil { return false }
        guard let (key, modifiers) = VimKeyEvent.translate(press) else { return false }
        return handle(key: key, modifiers: modifiers)
    }

    @discardableResult
    public func handle(key: String, modifiers: VimModifiers = []) -> Bool {
        if textView.markedTextRange != nil { return false }
        // Command chords belong to the key-command table, never to vim.
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

    public func syncFromTextView() throws {
        guard !applyingEdits else { return }
        let string = (textView.text ?? "") as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange)
        try apply(
            engine.setText(
                textView.text ?? "", anchor: selection.location, head: NSMaxRange(selection)))
    }

    // MARK: - Applying results

    private func apply(_ result: VimResult) throws {
        if !result.edits.isEmpty && !result.resynced {
            if let failure = applyEdits(result.edits) {
                // The engine committed these to its mirror before handing them
                // over, so a partial replay leaves the two disagreeing and every
                // later journal range pointing at the wrong text.
                try resyncFromStorage()
                onReplayFailure?(failure)
                onStatusChange?(VimStatus(result: try engine.state()))
                return
            }
        }
        applySelection(result)
        if let scroll = result.scroll { applyScroll(scroll) }
        onStatusChange?(VimStatus(result: result))
    }

    private func resyncFromStorage() throws {
        let text = textView.text ?? ""
        let selection = GraphemeClamp.range(in: text as NSString, textView.selectedRange)
        applyingEdits = true
        defer { applyingEdits = false }
        _ = try engine.setText(
            text, anchor: selection.location, head: NSMaxRange(selection))
    }

    /// Returns nil on success, or the first failure — at which point replay has
    /// stopped and the caller must resync.
    private func applyEdits(_ edits: [VimEdit]) -> VimReplayFailure? {
        applyingEdits = true
        defer { applyingEdits = false }
        textView.undoManager?.beginUndoGrouping()
        defer { textView.undoManager?.endUndoGrouping() }

        for edit in edits {
            let length = ((textView.text ?? "") as NSString).length
            guard edit.range.location >= 0, NSMaxRange(edit.range) <= length,
                let range = textRange(for: edit.range)
            else {
                return .rangeOutOfBounds(edit.range, documentLength: length)
            }
            // A delegate that vetoes has no way to say so through `replace`, so
            // the check has to happen before the call.
            if let delegate = textView.delegate,
                delegate.textView?(
                    textView, shouldChangeTextIn: edit.range,
                    replacementText: edit.insert) == false
            {
                return .rejectedByDelegate(edit.range)
            }
            textView.replace(range, withText: edit.insert)
        }
        return nil
    }

    private func applySelection(_ result: VimResult) {
        let length = ((textView.text ?? "") as NSString).length
        var range = result.primarySelection.range
        range.location = min(range.location, length)
        range.length = min(range.length, length - range.location)
        textView.selectedRange = range
    }

    private func applyScroll(_ scroll: VimScrollRequest) {
        switch scroll.kind {
        case "scrollIntoView":
            let range = scroll.offset.map { NSRange(location: $0, length: 0) }
                ?? textView.selectedRange
            textView.scrollRangeToVisible(range)
        case "scrollTo":
            if let y = scroll.y {
                textView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            }
        default:
            break
        }
    }

    /// `NSRange` (UTF-16, what JS speaks) to `UITextRange` (opaque positions).
    private func textRange(for range: NSRange) -> UITextRange? {
        guard let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
            let end = textView.position(from: start, offset: range.length)
        else { return nil }
        return textView.textRange(from: start, to: end)
    }

    // MARK: - VimGeometryProvider

    public func lineHeight() -> Double {
        Double(textView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight)
    }

    public func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double) {
        guard let position = textView.position(from: textView.beginningOfDocument, offset: offset)
        else { return (0, 0, lineHeight()) }
        let rect = textView.caretRect(for: position)
        return (Double(rect.minX), Double(rect.minY), Double(rect.maxY))
    }

    public func offsetAtCoords(left: Double, top: Double) -> Int {
        guard
            let position = textView.closestPosition(to: CGPoint(x: left, y: top))
        else { return 0 }
        return textView.offset(from: textView.beginningOfDocument, to: position)
    }

    public func scrollInfo() -> (top: Double, height: Double, clientHeight: Double) {
        (
            Double(textView.contentOffset.y),
            Double(textView.contentSize.height),
            Double(textView.bounds.height)
        )
    }

    /// `j`/`k` over display lines.
    ///
    /// `UITextInput.position(from:in:offset:)` with `.down`/`.up` already means
    /// "one display line", so soft wrapping is handled by the text system rather
    /// than by walking fragments as the AppKit adapter has to. The goal column
    /// is approximated by re-finding the closest position on the new line, which
    /// is what UIKit's own arrow keys do.
    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        guard unit == "line", amount != 0,
            let start = textView.position(from: textView.beginningOfDocument, offset: offset)
        else { return nil }

        let direction: UITextLayoutDirection = amount > 0 ? .down : .up
        var position = start
        var hitSide = false
        for _ in 0..<abs(amount) {
            guard let next = textView.position(from: position, in: direction, offset: 1) else {
                hitSide = true
                break
            }
            position = next
        }

        if let goalColumn {
            let rect = textView.caretRect(for: position)
            if let onGoal = textView.closestPosition(
                to: CGPoint(x: CGFloat(goalColumn), y: rect.midY))
            {
                position = onGoal
            }
        }
        return (textView.offset(from: textView.beginningOfDocument, to: position), hitSide)
    }

    // MARK: - VimHistoryProvider

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
        let text = textView.text ?? ""
        let selection = GraphemeClamp.range(in: text as NSString, textView.selectedRange)
        return (text, selection.location, NSMaxRange(selection))
    }
}
#endif
