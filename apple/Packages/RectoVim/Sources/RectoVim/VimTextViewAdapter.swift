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

    /// Replay could not be completed and the engine has been resynced from the
    /// storage. The document is intact; whatever the keystroke was doing is not.
    /// A host should surface this rather than swallow it — silently continuing
    /// is what desynchronises the mirror.
    public var onReplayFailure: ((VimReplayFailure) -> Void)?

    /// True while we are writing into the storage ourselves, so the text view's
    /// own change notifications do not bounce back into JS as external edits.
    private var applyingEdits = false

    /// The same, for the selection: the text view reports every selection change
    /// back to us, and a vim command's own answer must not come round again as
    /// if the user had moved the caret. See `selectionDidChangeExternally`.
    private var applyingSelection = false
    private var lastAppliedSelection: NSRange?

    /// The undo group currently open across keystrokes, if any.
    ///
    /// Vim's undo unit is one *command*, and an insert session is one command:
    /// `iabc<Esc>` then `u` removes `abc`, not just the `c`. Each bridge edit
    /// used to open and close its own group, so `u` removed one character.
    private var openInsertGroup: InsertGroup?

    /// Set by the undo action registered alongside each group when that group is
    /// undone or redone. Nil means the step was not one of ours — an external
    /// edit — and the text view's own restored selection is the best answer.
    private var restoredPatchStart: Int?

    private struct InsertGroup {
        /// Start of the union of everything the session has written so far.
        var patchStart: Int
        /// What `groupsByEvent` was before the session opened.
        let previousGroupsByEvent: Bool
    }

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
        try engine.start(text: textView.string)

        // The text view's input system owns text input from here on: it is the
        // only thing that sees NFD sequences, dead-key compositions, emoji and
        // IME as what they are. `BlockCaretTextView` routes them back through
        // `insertText`; a custom text view must forward
        // `insertText(_:replacementRange:)` the same way.
        engine.setExternalInput(true)
        if let hooked = textView as? BlockCaretTextView {
            // Without this the text view sends every physical key straight to
            // AppKit and the vim layer never sees a keystroke at all.
            hooked.keyHook = { [weak self] event in self?.handle(event) ?? false }
            hooked.inputHook = { [weak self] text, range in
                self?.insertText(text, replacementRange: range) ?? false
            }
            // Anything that changed the storage without going through us —
            // a composition, a menu command, a drag — is taken back here.
            // Both are no-ops while we are applying our own edits.
            hooked.willChangeTextExternally = { [weak self] in
                self?.willChangeTextExternally()
            }
            hooked.textDidChangeExternally = { [weak self] source in
                switch source {
                case .composition: try? self?.syncCompositionFromTextView()
                case .external: try? self?.syncFromTextView()
                }
            }
            // An arrow key insert mode declines, Home/End, a click: the text
            // view moves the caret and the engine has to follow it.
            hooked.selectionDidChangeExternally = { [weak self] in
                self?.selectionDidChangeExternally()
            }
        }
        try apply(engine.state())
    }

    /// Text the input system produced. Returns true when vim took it, in which
    /// case the text view must not insert it itself.
    ///
    /// A `replacementRange` of `NSNotFound` means "the current selection", which
    /// is what the engine does by default.
    @discardableResult
    public func insertText(
        _ text: String,
        replacementRange: NSRange = NSRange(location: NSNotFound, length: 0)
    ) -> Bool {
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

    /// Returns true when vim consumed the key, in which case the text view must
    /// not also handle it.
    public func handle(_ event: NSEvent) -> Bool {
        // Belt and braces for a host that installs its own key hook:
        // `BlockCaretTextView` already bypasses vim during composition, and a
        // key that reaches vim mid-composition desynchronises the mirror.
        if textView.hasMarkedText() { return false }
        guard let (key, modifiers) = VimKeyEvent.translate(event) else { return false }
        return handle(key: key, modifiers: modifiers)
    }

    /// One key by DOM name, for callers that already have one — the keystroke
    /// suite, a menu item, a synthesised key from a macro.
    @discardableResult
    public func handle(key: String, modifiers: VimModifiers = []) -> Bool {
        if textView.hasMarkedText() { return false }
        // Command chords belong to the menu bar, never to vim. History is the
        // exception: the adapter must close its explicit group before AppKit's
        // undo manager runs, or Command-Z aborts the process.
        if modifiers.contains(.command) {
            if key.lowercased() == "z" {
                return performPlatformHistory(redo: modifiers.contains(.shift))
            }
            return false
        }
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
        // Someone else changed the document, so whatever command was in progress
        // is over as far as undo is concerned.
        closeInsertGroup()
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        try apply(
            engine.setText(
                textView.string,
                anchor: selection.location,
                head: NSMaxRange(selection)))
    }

    /// The same, for a change the input system made to its own marked text.
    ///
    /// A composition is not an external edit: it is the user typing, in insert
    /// mode, and `setText`'s cancelling `<Esc>` dropped the engine into normal
    /// mode on the *first* marked-text change. Committing `日` mid-insert then
    /// left the next `y` running as an operator. `adoptText` records the change
    /// and keeps the mode.
    ///
    /// While marked text is up AppKit owns the selection, so the engine's answer
    /// is deliberately not pushed back — doing so can end the composition.
    public func syncCompositionFromTextView() throws {
        guard !applyingEdits else { return }
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        let result = try engine.adoptText(
            textView.string, anchor: selection.location, head: NSMaxRange(selection),
            composing: textView.hasMarkedText())
        guard !textView.hasMarkedText() else {
            onStatusChange?(VimStatus(result: result))
            return
        }
        try apply(result)
    }

    /// Something that is not vim is about to change the text.
    ///
    /// Closing the group here rather than in `didChangeText` is the whole point:
    /// by then AppKit has already registered the external undo action, and an
    /// action registered inside the open vim group makes one `u` undo the
    /// external edit and the whole insert session together.
    public func willChangeTextExternally() {
        guard !applyingEdits else { return }
        closeInsertGroup()
    }

    /// The text view moved the caret without asking the engine — an arrow key or
    /// Home/End that insert mode declined, a click, a menu command.
    ///
    /// Vim starts a new undo block at a cursor key, so the open insert group is
    /// closed first unless `<C-g>U` asked for it to continue.
    public func selectionDidChangeExternally() {
        guard !applyingEdits, !applyingSelection, !textView.hasMarkedText() else { return }
        let selection = textView.selectedRange()
        // The engine's own answer coming back around; nothing moved.
        guard selection != lastAppliedSelection else { return }
        do {
            let clamped = GraphemeClamp.range(in: textView.string as NSString, selection)
            let result = try engine.moveCursorFromHost(
                anchor: clamped.location, head: NSMaxRange(clamped))
            if result.undoBreak { closeInsertGroup() }
            try apply(result)
        } catch {
            Self.log.error(
                "selection handoff failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Applying results

    private func apply(_ result: VimResult) throws {
        if !result.edits.isEmpty && !result.resynced {
            if let failure = applyEdits(result.edits, insertMode: result.insertMode) {
                // The engine committed these edits to its mirror before handing
                // them over, so a partial replay leaves the two disagreeing and
                // every later journal range pointing at the wrong text. Take the
                // storage as the truth and tell the engine.
                try resyncFromStorage()
                onReplayFailure?(failure)
                onStatusChange?(VimStatus(result: try engine.state()))
                return
            }
        }
        // Leaving insert mode ends the command, and so ends the undo group,
        // even on a keystroke that wrote nothing (`<Esc>` itself).
        if !result.insertMode { closeInsertGroup() }
        applySelection(result)
        applyCaretShape(result)
        if let scroll = result.scroll { applyScroll(scroll) }
        onStatusChange?(VimStatus(result: result))
    }

    /// Hand the storage back to the engine as the source of truth.
    private func resyncFromStorage() throws {
        closeInsertGroup()
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        applyingEdits = true
        defer { applyingEdits = false }
        _ = try engine.setText(
            textView.string, anchor: selection.location, head: NSMaxRange(selection))
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
    /// Returns nil on success, or the first failure — at which point replay has
    /// stopped and the caller must resync.
    ///
    /// `insertMode` decides the undo granularity. In insert mode the group stays
    /// open across keystrokes so the whole session undoes as one command; every
    /// other command is a group of its own.
    private func applyEdits(_ edits: [VimEdit], insertMode: Bool) -> VimReplayFailure? {
        guard let storage = textView.textStorage else {
            return .noTextStorage
        }
        applyingEdits = true
        defer { applyingEdits = false }

        if !insertMode { closeInsertGroup() }
        openGroupIfNeeded()
        defer { if !insertMode { closeInsertGroup() } }

        var applied: [NSRange] = []
        for edit in edits {
            // Bounds before the cluster check: a range that does not fit the
            // document is the two sides already out of step, and the clamp
            // assertion would fire on it first and report the wrong cause.
            let length = (textView.string as NSString).length
            guard edit.range.location >= 0, NSMaxRange(edit.range) <= length else {
                return .rangeOutOfBounds(edit.range, documentLength: length)
            }
            assertClampIsIdentity(edit.range, "edit")
            // JS offsets are UTF-16 code units and so is NSRange, so this is a
            // straight handover — the reason the adapter works in offsets rather
            // than in (line, column) pairs.
            guard textView.shouldChangeText(in: edit.range, replacementString: edit.insert)
            else {
                return .rejectedByDelegate(edit.range)
            }
            storage.replaceCharacters(in: edit.range, with: edit.insert)
            textView.didChangeText()
            // Post-edit coordinates: this is where the text ends up, which is
            // where the caret goes when the step is undone.
            applied.append(
                NSRange(location: edit.range.location, length: edit.insert.utf16.count))
        }
        extendOpenGroup(with: applied)
        return nil
    }

    /// Opens an undo group if one is not already open, and turns off event
    /// grouping for its duration.
    ///
    /// Off only while our own writes are happening. Leaving it off breaks IME:
    /// `setMarkedText` reaches `-[NSUndoManager _prepareEventGrouping]` through
    /// AppKit's coalescing path, which raises when event grouping is disabled.
    /// Leaving it *on* is no good either — with no run loop turning, AppKit
    /// swallows a whole session into one group and one `u` undid everything.
    private func openGroupIfNeeded() {
        guard openInsertGroup == nil else { return }
        let undoManager = textView.undoManager
        let previous = undoManager?.groupsByEvent ?? true
        undoManager?.groupsByEvent = false
        undoManager?.beginUndoGrouping()
        openInsertGroup = InsertGroup(patchStart: Int.max, previousGroupsByEvent: previous)
    }

    private func extendOpenGroup(with ranges: [NSRange]) {
        guard var group = openInsertGroup else { return }
        for range in ranges { group.patchStart = min(group.patchStart, range.location) }
        openInsertGroup = group
    }

    /// Closes the open group, registering the caret **inside** it so the two
    /// travel together.
    ///
    /// This is the whole reason there is no parallel stack any more: an external
    /// edit adds its own undo entry, and a side-stack keyed only by order would
    /// hand that entry the caret belonging to the vim edit before it. An action
    /// registered in the group is consumed exactly when that group is undone.
    private func closeInsertGroup() {
        guard let group = openInsertGroup else { return }
        openInsertGroup = nil
        let undoManager = textView.undoManager
        if group.patchStart != Int.max {
            registerCaret(group.patchStart, on: undoManager)
        }
        undoManager?.endUndoGrouping()
        undoManager?.groupsByEvent = group.previousGroupsByEvent
        // NSTextView coalesces consecutive typing into one undo group, which
        // would make a single `u` throw away a whole editing session.
        textView.breakUndoCoalescing()
    }

    /// Registers an action that reports `start` when this transaction is undone,
    /// and re-registers itself so redo reports it too.
    private func registerCaret(_ start: Int, on undoManager: UndoManager?) {
        guard let undoManager else { return }
        undoManager.registerUndo(withTarget: self) { adapter in
            adapter.restoredPatchStart = start
            adapter.registerCaret(start, on: undoManager)
        }
    }

    private func performPlatformHistory(redo: Bool) -> Bool {
        guard let undoManager = textView.undoManager else { return false }
        closeInsertGroup()
        guard redo ? undoManager.canRedo : undoManager.canUndo else { return false }

        applyingEdits = true
        if redo { undoManager.redo() } else { undoManager.undo() }
        applyingEdits = false

        do {
            try syncFromTextView()
            return true
        } catch {
            Self.log.error(
                "platform history sync failed: \(String(describing: error), privacy: .public)")
            return true
        }
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
        lastAppliedSelection = range
        applyingSelection = true
        defer { applyingSelection = false }
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

    /// The TextKit 2 fragment walk, shared with the product's controller.
    private var geometry: VimTextKitGeometry { VimTextKitGeometry(textView: textView) }

    public func lineHeight() -> Double { geometry.lineHeight() }

    public func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double) {
        geometry.charCoords(offset: offset)
    }

    public func offsetAtCoords(left: Double, top: Double) -> Int {
        geometry.offsetAtCoords(left: left, top: top)
    }

    public func scrollInfo() -> (top: Double, height: Double, clientHeight: Double) {
        geometry.scrollInfo()
    }

    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        geometry.verticalMove(from: offset, amount: amount, unit: unit, goalColumn: goalColumn)
    }

    // MARK: - VimHistoryProvider

    /// `u` / `<C-r>`.
    ///
    /// The host owns undo, exactly as `u` is remapped to the document's undo
    /// tree on the web, so the engine never runs vim's own history. This routes
    /// to the text view's undo manager; the product routes to `RectoHistory`,
    /// which is why this is a protocol rather than a direct call.
    ///
    /// The caret is **vim's**, and it comes from the patch.
    ///
    /// Vim puts the cursor at the start of the change it just restored. The undo
    /// manager restores whatever selection it recorded — two lines away, in the
    /// spike's proof — and diffing the two full strings, which is what this did
    /// before, cannot recover the location when the surrounding text repeats:
    /// on `"aa"`, `ia<Esc>u` put the caret at offset 1 where the patch started
    /// at 0. `VimUndoPatchLog` carries the range each step wrote, so this reads
    /// it back instead of guessing. That is the same thing `RectoHistory` will
    /// do with its own patch.
    public func performHistory(_ kind: String) -> VimHistoryResult? {
        guard let undoManager = textView.undoManager else { return nil }
        closeInsertGroup()
        applyingEdits = true
        defer { applyingEdits = false }

        // Nil unless one of our own transactions reports its patch. An external
        // edit's undo step has no caret action, and the text view's restored
        // selection is then the only honest answer.
        restoredPatchStart = nil
        if kind == "undo" {
            guard undoManager.canUndo else { return nil }
            undoManager.undo()
        } else {
            guard undoManager.canRedo else { return nil }
            undoManager.redo()
        }
        let after = textView.string as NSString
        let recorded = restoredPatchStart ?? textView.selectedRange().location
        return VimHistoryResult(
            text: after as String,
            patchStart: GraphemeClamp.caret(
                in: after, offset: min(max(recorded, 0), after.length)))
    }
}
#endif
