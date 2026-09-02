//
//  RectoVimController.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine
import Observation
import os
import RectoVim

/// Vim over the engine's text view: the `.vim` presentation's key layer.
///
/// Attach it through `RectoEditorView.onAttach`, like `RectoFindController`.
/// It installs itself as the engine's `MarkdownKeyInterceptor`, so every
/// physical key and every string the input system produces is offered to
/// `VimEngine` first; whatever vim declines falls through to `NSTextView`, which
/// is what keeps ⌘ shortcuts, IME and the system text affordances working.
///
/// ### Edits
///
/// A keystroke comes back from JS as an edit journal. The journal is replayed
/// onto a copy of the text and the result goes through `RectoTextView.applyText`
/// — one engine patch, one `onTextMutation`, one `onEdit` per vim command. The
/// storage is never written directly and `NSTextView.string` is never assigned.
///
/// ### Undo
///
/// `u`/`<C-r>` go to ``history``, the same `RectoEditorHistory` ⌘Z reaches.
/// Nothing here touches `NSUndoManager`: under `undo: .external` the engine
/// registers no actions, and the shipped `VimTextViewAdapter`'s AppKit undo
/// grouping would find nothing to group in one host and the app's manager by
/// accident in the other. An insert session is bracketed by
/// `begin/endCommandGroup` so the host can make it one step.
@Observable
@MainActor
public final class RectoVimController {
    /// Mode label, pending keys, the open `:`/`/` line and the last one-shot
    /// message — everything a status line renders. `nil` while detached.
    public private(set) var status: VimStatus?

    /// The host's undo. `u`/`<C-r>` do nothing while this is `nil`.
    @ObservationIgnored public weak var history: (any RectoEditorHistory)?

    /// `:w`.
    @ObservationIgnored public var onSave: (() -> Void)?

    /// Replaying a keystroke's edits failed and the engine was resynced from
    /// the storage. The document is intact; the keystroke's effect is not.
    @ObservationIgnored public var onReplayFailure: ((VimReplayFailure) -> Void)?

    @ObservationIgnored private let host = VimHost()
    @ObservationIgnored private var engine: VimEngine?
    @ObservationIgnored private var seam: RectoTextView?
    @ObservationIgnored private weak var textView: NSTextView?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    /// True while our own edits are landing, so the text view's change
    /// notifications do not come back around as external edits.
    @ObservationIgnored private var applyingEdits = false
    /// The same for the selection: vim's own answer must not be handed back to
    /// it as a host cursor move.
    @ObservationIgnored private var applyingSelection = false
    @ObservationIgnored private var lastAppliedSelection: NSRange?
    /// The input system had marked text up the last time we looked. A change
    /// arriving with none is then the composition ending, which vim adopts
    /// rather than treating as an outside edit.
    @ObservationIgnored private var compositionWasActive = false
    /// An insert session's `beginCommandGroup` is open on the host.
    @ObservationIgnored private var commandGroupIsOpen = false

    private static let log = Logger(subsystem: "com.bhekani.recto", category: "RectoVim")

    public init() {}

    /// Vim's registers and marks as JSON, for the host to persist across
    /// launches. `nil` before the engine has started.
    public func saveState() -> String? { engine?.saveState() }

    public func restoreState(_ json: String) { engine?.restoreState(json) }

    /// Whether a key layer is installed on a live editor.
    public var isAttached: Bool { textView != nil }

    /// The engine's copy of the document. It must always equal the storage;
    /// the suites assert that after every keystroke.
    var engineText: String? { engine?.text() }

    // MARK: - Attach

    /// Attach the current editor seam, or detach with `nil`.
    public func attach(to seam: RectoTextView?) {
        let incoming = seam?.nsTextView
        if incoming === textView {
            self.seam = seam
            return
        }
        detach()
        guard let seam, let textView = incoming else { return }
        self.seam = seam
        self.textView = textView
        do {
            let engine = try self.engine ?? VimEngine(host: host)
            self.engine = engine
            host.geometryProvider = self
            host.historyProvider = self
            host.onSave = { [weak self] in self?.onSave?() }
            try engine.start(text: textView.string)
            // The text view's input system owns text input: it is the only
            // thing that sees NFD, dead keys, emoji and IME as what they are.
            engine.setExternalInput(true)
            seam.installKeyInterceptor(self)
            installObservers(on: textView)
            let selection = GraphemeClamp.range(in: textView.string as NSString, textView.selectedRange())
            try apply(engine.setText(
                textView.string, anchor: selection.location, head: NSMaxRange(selection)))
        } catch {
            Self.log.error("vim could not start: \(String(describing: error), privacy: .public)")
            detach()
        }
    }

    private func detach() {
        closeCommandGroup()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let seam {
            seam.removeKeyInterceptor(self)
            seam.caretShape = .bar
        }
        seam = nil
        textView = nil
        lastAppliedSelection = nil
        compositionWasActive = false
        status = nil
    }

    private func installObservers(on textView: NSTextView) {
        observers = [
            NotificationCenter.default.addObserver(
                forName: NSText.didChangeNotification, object: textView, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.textDidChange() }
            },
            NotificationCenter.default.addObserver(
                forName: NSTextView.didChangeSelectionNotification, object: textView, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.selectionDidChange() }
            },
        ]
    }

    // MARK: - Text and selection the layer did not produce

    /// Something changed the storage without going through vim: a composition,
    /// a menu command, a drag, a sync landing, a history jump.
    private func textDidChange() {
        guard !applyingEdits, let engine, let textView else { return }
        let composing = textView.hasMarkedText()
        let endedComposition = compositionWasActive && !composing
        compositionWasActive = composing
        let selection = GraphemeClamp.range(in: textView.string as NSString, textView.selectedRange())
        do {
            if composing || endedComposition {
                // Not an external edit: the user is typing, in insert mode, and
                // `setText`'s cancelling `<Esc>` would drop to normal mode on the
                // first marked-text change. While marked text is up AppKit owns
                // the selection, so vim's answer is not pushed back.
                let result = try engine.adoptText(
                    textView.string, anchor: selection.location, head: NSMaxRange(selection),
                    composing: composing)
                if composing {
                    status = VimStatus(result: result)
                } else {
                    try apply(result)
                }
            } else {
                // Whatever command was in progress is over as far as undo goes.
                closeCommandGroup()
                try apply(engine.setText(
                    textView.string, anchor: selection.location, head: NSMaxRange(selection)))
            }
        } catch {
            Self.log.error("external text sync failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// The text view moved the caret itself: an arrow key insert mode declined,
    /// Home/End, a click, a menu command.
    private func selectionDidChange() {
        guard !applyingEdits, !applyingSelection, let engine, let textView else { return }
        if textView.hasMarkedText() {
            compositionWasActive = true
            return
        }
        let selection = textView.selectedRange()
        guard selection != lastAppliedSelection else { return }
        do {
            let clamped = GraphemeClamp.range(in: textView.string as NSString, selection)
            let result = try engine.moveCursorFromHost(
                anchor: clamped.location, head: NSMaxRange(clamped))
            // Vim starts a new undo block at a cursor key unless `<C-g>U` asked
            // for the block to continue; JS made that call.
            if result.undoBreak { closeCommandGroup() }
            try apply(result)
        } catch {
            Self.log.error("selection handoff failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Applying results

    private func apply(_ result: VimResult) throws {
        if !result.edits.isEmpty && !result.resynced {
            switch applyEdits(result.edits, insertMode: result.insertMode) {
            case .applied:
                break
            case .normalised:
                // The keystroke landed, but the storage rewrote it (line
                // endings). The mirror follows the storage; the caret is where
                // the engine left it, clamped.
                try resyncFromStorage()
            case .failed(let failure):
                // JS committed these edits to its mirror before handing them
                // over; a partial replay leaves the two disagreeing. The storage
                // is the truth: tell the engine, and tell the host.
                try resyncFromStorage()
                onReplayFailure?(failure)
                status = VimStatus(result: try engine?.state() ?? result)
                return
            }
        }
        // Leaving insert mode ends the command, and so the group, even on a
        // keystroke that wrote nothing (`<Esc>` itself).
        if !result.insertMode { closeCommandGroup() }
        applySelection(result)
        seam?.caretShape = Self.caretShape(for: VimCaretShape(mode: result.mode))
        if let scroll = result.scroll { applyScroll(scroll) }
        status = VimStatus(result: result)
    }

    private enum ReplayOutcome {
        case applied
        /// The edit landed but the storage rewrote it (line-ending policy).
        case normalised
        case failed(VimReplayFailure)
    }

    /// Replay the journal onto a copy and land it as one edit.
    ///
    /// Ranges are applied verbatim: they came out of the JS mirror, which snaps
    /// them to grapheme boundaries, and re-clamping against ICU could disagree
    /// by a code unit and desynchronise the two buffers.
    private func applyEdits(_ edits: [VimEdit], insertMode: Bool) -> ReplayOutcome {
        guard let seam, let textView else { return .failed(.noTextStorage) }
        let text = NSMutableString(string: textView.string)
        for edit in edits {
            guard edit.range.location >= 0, NSMaxRange(edit.range) <= text.length else {
                return .failed(.rangeOutOfBounds(edit.range, documentLength: text.length))
            }
            text.replaceCharacters(in: edit.range, with: edit.insert)
        }
        if insertMode { openCommandGroup() } else { closeCommandGroup() }

        applyingEdits = true
        defer { applyingEdits = false }
        // One edit is the common case (`x`, `dw`, a typed character) and is
        // already a patch; the whole-document diff behind `applyText` is only
        // needed to collapse a multi-edit journal into one run.
        let landed = edits.count == 1
            ? seam.applyPatch(MarkdownTextPatch(range: edits[0].range, replacement: edits[0].insert))
            : seam.applyText(text as String)
        guard landed else { return .failed(.rejectedByDelegate(edits[0].range)) }
        return (textView.string as NSString).isEqual(to: text as String) ? .applied : .normalised
    }

    /// Hand the storage back to the engine as the source of truth.
    private func resyncFromStorage() throws {
        guard let engine, let textView else { return }
        closeCommandGroup()
        let string = textView.string as NSString
        let selection = GraphemeClamp.range(in: string, textView.selectedRange())
        applyingEdits = true
        defer { applyingEdits = false }
        _ = try engine.setText(
            textView.string, anchor: selection.location, head: NSMaxRange(selection))
    }

    private func applySelection(_ result: VimResult) {
        guard let textView else { return }
        let length = (textView.string as NSString).length
        var range = result.primarySelection.range
        // In normal mode vim's caret sits *on* a character; a zero-width
        // selection would draw as a bar, so the caret shape carries the mode.
        range.location = min(range.location, length)
        range.length = min(range.length, length - range.location)
        lastAppliedSelection = range
        applyingSelection = true
        defer { applyingSelection = false }
        textView.setSelectedRange(range)
    }

    private static func caretShape(for shape: VimCaretShape) -> MarkdownCaretShape {
        switch shape {
        case .bar: return .bar
        case .block: return .block
        case .hollow: return .hollow
        }
    }

    private func applyScroll(_ scroll: VimScrollRequest) {
        guard let seam, let textView else { return }
        switch scroll.kind {
        case "scrollIntoView":
            let range = scroll.offset.map { NSRange(location: $0, length: 0) } ?? textView.selectedRange()
            seam.scroll(range: range, position: .nearest)
        case "scrollTo":
            // Best effort until the engine exposes a vertical-offset scroll that
            // also cancels its pending restore (plan 024 slice V2).
            if let y = scroll.y, let scrollView = seam.scrollView {
                scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
        default:
            break
        }
    }

    // MARK: - Command groups

    private func openCommandGroup() {
        guard !commandGroupIsOpen else { return }
        commandGroupIsOpen = true
        history?.beginCommandGroup()
    }

    private func closeCommandGroup() {
        guard commandGroupIsOpen else { return }
        commandGroupIsOpen = false
        history?.endCommandGroup()
    }
}

// MARK: - MarkdownKeyInterceptor

extension RectoVimController: MarkdownKeyInterceptor {
    public func interceptKeyDown(_ event: NSEvent, in textView: NSTextView) -> Bool {
        guard let engine, textView === self.textView,
              let (key, modifiers) = VimKeyEvent.translate(event) else { return false }
        // Command chords belong to the menu bar: ⌘Z reaches the host's history
        // through the responder chain, the same place `u` ends up.
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

    public func interceptInsertText(_ text: String, replacementRange: NSRange, in textView: NSTextView) -> Bool {
        guard let engine, textView === self.textView else { return false }
        do {
            let result = replacementRange.location == NSNotFound
                ? try engine.insertText(text)
                : try engine.insertText(text, from: replacementRange.location, to: NSMaxRange(replacementRange))
            try apply(result)
            return result.handled
        } catch {
            Self.log.error("insertText failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    public func interceptCommand(_ selector: Selector, in textView: NSTextView) -> Bool {
        // Every key vim wants is taken in `interceptKeyDown`; what reaches here
        // is what it declined (arrow keys in insert mode, unbound chords), and
        // AppKit's handling of those is what vim expects — the resulting
        // selection change comes back through `moveCursorFromHost`.
        false
    }
}

// MARK: - VimGeometryProvider

extension RectoVimController: VimGeometryProvider {
    private var geometry: VimTextKitGeometry? {
        textView.map(VimTextKitGeometry.init(textView:))
    }

    public func lineHeight() -> Double { geometry?.lineHeight() ?? 0 }

    public func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double) {
        geometry?.charCoords(offset: offset) ?? (0, 0, 0)
    }

    public func offsetAtCoords(left: Double, top: Double) -> Int {
        geometry?.offsetAtCoords(left: left, top: top) ?? 0
    }

    public func scrollInfo() -> (top: Double, height: Double, clientHeight: Double) {
        geometry?.scrollInfo() ?? (0, 0, 0)
    }

    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        geometry?.verticalMove(from: offset, amount: amount, unit: unit, goalColumn: goalColumn)
    }
}

// MARK: - VimHistoryProvider

extension RectoVimController: VimHistoryProvider {
    /// `u` / `<C-r>`, answered by the host's history inside the keystroke.
    ///
    /// The host applies the step to the storage (through `applyText`, with the
    /// engine registering nothing) and reports where the restored change
    /// starts; JS resets its mirror to the returned text, so nothing here
    /// echoes back as an edit.
    public func performHistory(_ kind: String) -> VimHistoryResult? {
        guard let history, let textView else { return nil }
        closeCommandGroup()
        applyingEdits = true
        defer { applyingEdits = false }
        guard let outcome = history.performHistory(kind == "undo" ? .undo : .redo) else {
            return nil
        }
        let after = textView.string as NSString
        guard after.isEqual(to: outcome.markdown) else {
            // The host did not land it synchronously; its later storage change
            // will reach `textDidChange` as an external edit.
            return nil
        }
        return VimHistoryResult(
            text: outcome.markdown,
            patchStart: GraphemeClamp.caret(
                in: after, offset: min(max(outcome.patchStart, 0), after.length)))
    }
}
