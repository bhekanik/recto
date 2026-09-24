//
//  RectoFocusBlurController.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// Focus blur: the line being written stays sharp and every other line blurs,
/// more the further away it is.
///
/// The engine draws the blur, line by line, as its layout fragments paint
/// (``MarkdownFocusBlur``); this keeps it told where the caret's line is.
/// Live text, no snapshots, and nothing but a redraw when the caret changes
/// line. Give ``attach(to:)`` the editor seam, as for
/// ``RectoTypewriterController``.
@MainActor
public final class RectoFocusBlurController {
    public var isEnabled: Bool {
        didSet {
            guard isEnabled != oldValue else { return }
            refreshActivation()
        }
    }

    /// Blur at full strength, in points.
    public static let maximumRadius: CGFloat = 6
    /// Lines of distance over which the blur ramps from a trace to full.
    public static let rampLines: CGFloat = 6

    /// The band behind the sharp line; `nil` for none.
    public var lineHighlight: NSColor? {
        didSet { if isEnabled { update() } }
    }

    private var seam: RectoTextView?
    private weak var textView: NSTextView?
    private var tokens: [NSObjectProtocol] = []
    private var isUpdateScheduled = false

    /// What the engine is drawing now, for tests and diagnostics.
    public var current: MarkdownFocusBlur? { seam?.editorController.focusBlur }

    public init(isEnabled: Bool = false) {
        self.isEnabled = isEnabled
    }

    isolated deinit {
        deactivate()
    }

    public func attach(to seam: RectoTextView?) {
        let incoming = seam?.nsTextView
        guard incoming !== textView else {
            self.seam = seam
            return
        }
        deactivate()
        self.seam = seam
        textView = incoming
        refreshActivation()
    }

    private func refreshActivation() {
        guard isEnabled, let textView else {
            deactivate()
            return
        }
        guard tokens.isEmpty else { return }
        let center = NotificationCenter.default
        for name in [NSTextView.didChangeSelectionNotification, NSText.didChangeNotification] {
            tokens.append(center.addObserver(forName: name, object: textView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleUpdate() }
            })
        }
        update()
    }

    private func deactivate() {
        tokens.forEach(NotificationCenter.default.removeObserver)
        tokens.removeAll()
        seam?.editorController.focusBlur = nil
    }

    /// Once per run-loop turn, after the edit's layout: a keystroke fires both
    /// notifications, and the line's frame is only final once laid out.
    private func scheduleUpdate() {
        guard !isUpdateScheduled else { return }
        isUpdateScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.isUpdateScheduled = false
                self?.update()
            }
        }
    }

    func update() {
        guard isEnabled, let seam, let line = caretLine() else { return }
        seam.editorController.focusBlur = MarkdownFocusBlur(
            lineMinY: line.minY,
            lineMaxY: line.maxY,
            maximumRadius: Self.maximumRadius,
            rampDistance: line.height * Self.rampLines,
            lineHighlight: lineHighlight?.cgColor
        )
    }

    /// The caret's line fragment, in text-container coordinates (the space
    /// the engine's layout fragments draw in).
    private func caretLine() -> CGRect? {
        guard let textView,
              let layoutManager = textView.textLayoutManager,
              let content = layoutManager.textContentManager,
              let location = content.location(
                content.documentRange.location, offsetBy: textView.selectedRange().location)
        else { return nil }
        var caret: CGRect?
        layoutManager.enumerateTextSegments(
            in: NSTextRange(location: location), type: .standard, options: [.rangeNotRequired]
        ) { _, frame, _, _ in
            caret = frame
            return false
        }
        guard let caret else { return nil }
        // The whole line the caret sits on, not just the caret's own box: a
        // heading or an empty line has its own height.
        var line = caret
        if let fragment = layoutManager.textLayoutFragment(for: CGPoint(x: caret.midX, y: caret.midY)) {
            let origin = fragment.layoutFragmentFrame.origin
            for lineFragment in fragment.textLineFragments {
                let bounds = lineFragment.typographicBounds.offsetBy(dx: origin.x, dy: origin.y)
                if bounds.minY <= caret.midY, caret.midY <= bounds.maxY {
                    line = bounds
                    break
                }
            }
        }
        return line
    }
}
