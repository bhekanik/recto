//
//  RectoFindController.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// Connects AppKit's standard Find bar to the text visible in one editor.
///
/// Attach it through `RectoEditorView.onAttach`. Rich and preview search the
/// reader-visible projection; raw searches the source. Replacement ranges map
/// back to source UTF-16 coordinates and enter through the normal editor path.
@MainActor
public final class RectoFindController: NSObject {
    private struct ApprovedReplacement {
        let visibleRange: NSRange
        let patch: MarkdownTextPatch
    }

    private var seam: RectoTextView?
    private weak var textView: NSTextView?
    private var finder: NSTextFinder?
    private var approvedReplacements: [ApprovedReplacement] = []
    private var requestedReplacements: [MarkdownTextPatch] = []

    public override init() {}

    /// Attach the current editor seam, or detach with `nil`.
    public func attach(to seam: RectoTextView?) {
        let incomingTextView = seam?.nsTextView
        if incomingTextView === textView {
            self.seam = seam
            return
        }

        detach()
        guard let seam, let textView = seam.nsTextView,
              let scrollView = seam.scrollView else { return }

        self.seam = seam
        self.textView = textView
        let finder = NSTextFinder()
        finder.client = self
        finder.findBarContainer = scrollView
        finder.isIncrementalSearchingEnabled = true
        self.finder = finder
        seam.installTextFinderResponder(self)
    }

    private func detach() {
        if let seam { seam.removeTextFinderResponder(self) }
        finder?.cancelFindIndicator()
        finder?.client = nil
        finder?.findBarContainer = nil
        finder = nil
        seam = nil
        textView = nil
        approvedReplacements.removeAll()
        requestedReplacements.removeAll()
    }

    private var projection: MarkdownTextProjection {
        seam?.textProjection ?? .make(markdown: "")
    }
}

extension RectoFindController: MarkdownTextFinderActionResponder {
    public func performTextFinderAction(_ action: NSTextFinder.Action) {
        finder?.performAction(action)
    }

    public func validateTextFinderAction(_ action: NSTextFinder.Action) -> Bool {
        finder?.validateAction(action) ?? false
    }

    public func textFinderClientStringWillChange() {
        finder?.noteClientStringWillChange()
    }
}

extension RectoFindController: NSTextFinderClient {
    public var string: String { projection.string }
    public var isSelectable: Bool { textView?.isSelectable ?? false }
    public var allowsMultipleSelection: Bool { false }
    public var isEditable: Bool { textView?.isEditable ?? false }

    public var firstSelectedRange: NSRange {
        guard let textView else { return NSRange(location: 0, length: 0) }
        return projection.visibleRange(for: textView.selectedRange())
            ?? NSRange(location: 0, length: 0)
    }

    public var selectedRanges: [NSValue] {
        get { [NSValue(range: firstSelectedRange)] }
        set {
            guard let visibleRange = newValue.first?.rangeValue,
                  let sourceRange = projection.sourceRange(for: visibleRange)
            else { return }
            textView?.setSelectedRange(sourceRange)
        }
    }

    public func scrollRangeToVisible(_ range: NSRange) {
        guard let seam,
              let sourceRange = projection.sourceRange(for: range) else { return }
        _ = seam.scroll(range: sourceRange)
    }

    public func shouldReplaceCharacters(
        inRanges ranges: [NSValue],
        with strings: [String]
    ) -> Bool {
        approvedReplacements.removeAll(keepingCapacity: true)
        requestedReplacements.removeAll(keepingCapacity: true)
        guard isEditable, ranges.count == strings.count else { return false }
        let projection = projection
        var approved: [ApprovedReplacement] = []
        for (value, replacement) in zip(ranges, strings) {
            let visibleRange = value.rangeValue
            guard visibleRange.length > 0,
                  let sourceRange = projection.sourceRange(for: visibleRange),
                  sourceRange.length > 0 else { return false }
            approved.append(ApprovedReplacement(
                visibleRange: visibleRange,
                patch: MarkdownTextPatch(range: sourceRange, replacement: replacement)
            ))
        }
        let ordered = approved.sorted { $0.patch.range.location < $1.patch.range.location }
        guard zip(ordered, ordered.dropFirst()).allSatisfy({ earlier, later in
            NSMaxRange(earlier.patch.range) <= later.patch.range.location
        }) else { return false }
        approvedReplacements = approved
        return true
    }

    public func replaceCharacters(in range: NSRange, with string: String) {
        guard let approvedIndex = approvedReplacements.firstIndex(where: {
            $0.visibleRange == range && $0.patch.replacement == string
        }) else { return }
        requestedReplacements.append(approvedReplacements.remove(at: approvedIndex).patch)
    }

    public func didReplaceCharacters() {
        defer {
            approvedReplacements.removeAll()
            requestedReplacements.removeAll()
        }
        guard let seam, approvedReplacements.isEmpty,
              !requestedReplacements.isEmpty else { return }
        _ = seam.applyPatches(requestedReplacements)
    }

    public func contentView(
        at index: Int,
        effectiveCharacterRange outRange: NSRangePointer
    ) -> NSView {
        outRange.pointee = NSRange(location: 0, length: projection.visibleUTF16Length)
        return textView ?? NSView()
    }

    public func rects(forCharacterRange range: NSRange) -> [NSValue]? {
        guard let seam,
              let sourceRange = projection.sourceRange(for: range) else { return nil }
        return seam.rects(forSourceRange: sourceRange).map(NSValue.init(rect:))
    }

    public var visibleCharacterRanges: [NSValue] {
        [NSValue(range: NSRange(location: 0, length: projection.visibleUTF16Length))]
    }
}
