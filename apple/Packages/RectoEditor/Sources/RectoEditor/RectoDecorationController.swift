//
//  RectoDecorationController.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// Display-only marks over the source: focus dimming and prose-lint
/// underlines (plan 024 C3). Nothing here touches the Markdown, the selection,
/// Find, copy output or undo.
///
/// Dimming has two layers. Layout fragments wholly outside the lit text draw
/// at the engine's dim alpha (`MarkdownEditorController.focusLitRange`), which
/// dims the bullets, checkboxes and images they paint themselves. In sentence
/// scope the lit fragments can also hold the neighbouring sentences, and those
/// are dimmed with a TextKit 2 rendering attribute, which colors text without
/// affecting layout. Lint underlines are drawn by the engine's fragments
/// (`MarkdownEditorController.underlines`): TextKit 2 does not reliably draw
/// underline rendering attributes (FB9692714).
@MainActor
public final class RectoDecorationController: NSObject {
    /// One lint finding: a UTF-16 source range, one of the web's four
    /// categories, and the message shown on hover.
    public struct LintMark: Equatable, Sendable {
        public var range: NSRange
        public var category: String
        public var message: String

        public init(range: NSRange, category: String, message: String) {
            self.range = range
            self.category = category
            self.message = message
        }
    }

    /// The web's `.recto-lint--*` colours (`packages/design-tokens`), dark and light.
    static func lintColor(_ category: String, dark: Bool) -> NSColor {
        switch (category, dark) {
        case ("passive", true): .oklch(0.74, 0.1, 290)
        case ("passive", false): .oklch(0.5, 0.13, 290)
        case ("readability", true): .oklch(0.84, 0.1, 85)
        case ("readability", false): .oklch(0.58, 0.12, 70)
        case ("adverb", true): .oklch(0.78, 0.08, 250)
        case ("adverb", false): .oklch(0.52, 0.11, 250)
        case ("weasel", true): .oklch(0.7, 0.09, 330)
        default: .oklch(0.52, 0.12, 330)
        }
    }

    /// `nil` dims nothing.
    public var focusDim: FocusDimScope? {
        didSet { if focusDim != oldValue { apply() } }
    }

    public var lintMarks: [LintMark] = [] {
        didSet { if lintMarks != oldValue { apply() } }
    }

    public var theme: RectoEditorTheme = .twilight {
        didSet { if theme != oldValue { apply() } }
    }

    /// The lit range last computed, for tests and for the embedder's status.
    public private(set) var litRange: NSRange?

    private var seam: RectoTextView?
    private weak var textView: NSTextView?
    private var observers: [NSObjectProtocol] = []
    private var toolTip: NSView.ToolTipTag?
    /// What this controller set, so clearing never touches another owner's
    /// rendering attributes (marked text, say).
    private var appliedDim: [NSRange] = []

    public override init() {
        super.init()
    }

    isolated deinit {
        detach()
    }

    public func attach(to seam: RectoTextView?) {
        if let incoming = seam?.nsTextView, incoming === textView {
            self.seam = seam
            return
        }
        detach()
        self.seam = seam
        textView = seam?.nsTextView
        guard let textView else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: NSTextView.didChangeSelectionNotification, object: textView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { if self?.focusDim != nil { self?.apply() } }
        })
        if let storage = textView.textStorage {
            observers.append(center.addObserver(
                forName: NSTextStorage.didProcessEditingNotification, object: storage, queue: .main
            ) { [weak self] notification in
                guard let storage = notification.object as? NSTextStorage else { return }
                let edited = storage.editedMask.contains(.editedCharacters)
                let range = storage.editedRange
                let delta = storage.changeInLength
                MainActor.assumeIsolated { if edited { self?.textDidChange(editedRange: range, delta: delta) } }
            })
        }
        textView.postsFrameChangedNotifications = true
        observers.append(center.addObserver(
            forName: NSView.frameDidChangeNotification, object: textView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.installToolTip() }
        })
        installToolTip()
        apply()
    }

    private func detach() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let toolTip, let textView { textView.removeToolTip(toolTip) }
        toolTip = nil
        clear()
        seam?.focusLitRange = nil
        seam?.underlines = []
        textView = nil
        seam = nil
    }

    /// Carry the lint marks through an edit so the underlines stay on their
    /// words while typing; the embedder's next lint pass replaces them. A
    /// mark the edit touched is dropped rather than guessed at.
    private func textDidChange(editedRange: NSRange, delta: Int) {
        let oldEnd = NSMaxRange(editedRange) - delta
        let editStart = editedRange.location
        lintMarks = lintMarks.compactMap { mark in
            if NSMaxRange(mark.range) <= editStart { return mark }
            if mark.range.location >= oldEnd {
                var moved = mark
                moved.range.location += delta
                return moved
            }
            return nil
        }
        // Rendering attributes are laid down against TextKit's own locations;
        // lay them again once this edit has been processed.
        DispatchQueue.main.async { [weak self] in self?.apply() }
    }

    // MARK: - Painting

    private func apply() {
        guard let textView, let seam else { return }
        let text = textView.string as NSString
        clear()

        if let scope = focusDim,
           let lit = FocusRange.active(in: text, caret: textView.selectedRange().location, scope: scope) {
            litRange = lit
            seam.focusLitRange = lit
            if scope == .sentence {
                // Only inside the lit lines: the fragments beyond them already
                // draw dimmed, and a second dim there would all but hide them.
                let lines = text.lineRange(for: lit)
                let before = NSRange(location: lines.location, length: lit.location - lines.location)
                let after = NSRange(location: NSMaxRange(lit), length: NSMaxRange(lines) - NSMaxRange(lit))
                for range in [before, after] where range.length > 0 {
                    setRendering([.foregroundColor: theme.ink.withAlphaComponent(0.35)], for: range)
                    appliedDim.append(range)
                }
            }
        } else {
            litRange = nil
            seam.focusLitRange = nil
        }

        let dark = theme.sheet.usingColorSpace(.sRGB).map { $0.brightnessComponent < 0.5 } ?? true
        seam.underlines = lintMarks
            .filter { NSMaxRange($0.range) <= text.length && $0.range.length > 0 }
            .map { MarkdownUnderline(range: $0.range, color: Self.lintColor($0.category, dark: dark)) }
    }

    private func clear() {
        guard let textView else { return }
        let length = (textView.string as NSString).length
        for range in appliedDim {
            removeRendering(.foregroundColor, for: clamp(range, to: length))
        }
        appliedDim.removeAll()
    }

    private func clamp(_ range: NSRange, to length: Int) -> NSRange {
        let start = min(range.location, length)
        return NSRange(location: start, length: min(NSMaxRange(range), length) - start)
    }

    private func textRange(_ range: NSRange) -> (NSTextLayoutManager, NSTextRange)? {
        guard range.length > 0,
              let manager = textView?.textLayoutManager,
              let content = manager.textContentManager,
              let start = content.location(content.documentRange.location, offsetBy: range.location),
              let end = content.location(start, offsetBy: range.length),
              let textRange = NSTextRange(location: start, end: end)
        else { return nil }
        return (manager, textRange)
    }

    private func setRendering(_ attributes: [NSAttributedString.Key: Any], for range: NSRange) {
        guard let (manager, textRange) = textRange(range) else { return }
        for (key, value) in attributes {
            manager.addRenderingAttribute(key, value: value, for: textRange)
        }
    }

    private func removeRendering(_ key: NSAttributedString.Key, for range: NSRange) {
        guard let (manager, textRange) = textRange(range) else { return }
        manager.removeRenderingAttribute(key, for: textRange)
    }

    // MARK: - Lint messages on hover

    /// One tooltip rect over the whole text view, answered per point: cheaper
    /// than a rect per mark, and it survives edits and scrolling untouched.
    private func installToolTip() {
        guard let textView else { return }
        if let toolTip { textView.removeToolTip(toolTip) }
        toolTip = textView.addToolTip(textView.bounds, owner: self, userData: nil)
    }

    /// The message of the lint mark under `point`, if any.
    public func lintMessage(at point: NSPoint) -> String? {
        guard let textView, !lintMarks.isEmpty else { return nil }
        let index = textView.characterIndexForInsertion(at: point)
        guard index != NSNotFound else { return nil }
        let messages = lintMarks
            .filter { index >= $0.range.location && index < NSMaxRange($0.range) }
            .map(\.message)
        return messages.isEmpty ? nil : messages.joined(separator: "\n")
    }
}

extension RectoDecorationController: NSViewToolTipOwner {
    public nonisolated func view(
        _ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?
    ) -> String {
        MainActor.assumeIsolated { lintMessage(at: point) ?? "" }
    }
}
