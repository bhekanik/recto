import AppKit
import MarkdownEngine
import Observation

@Observable
@MainActor
public final class RectoWritingController {
    public private(set) var selectionState = RectoEditorSelectionState()
    public private(set) var slashMenuState: RectoSlashMenuState?
    public var attachedTextView: NSTextView? { textView?.nsTextView }

    @ObservationIgnored public var onStateChange: (() -> Void)?
    @ObservationIgnored public var onActivateSlashEntry: ((RectoSlashEntry) -> Void)?

    @ObservationIgnored private weak var storage: RectoTextStorage?
    @ObservationIgnored private var textView: RectoTextView?
    @ObservationIgnored private var presentation: Presentation = .rich
    @ObservationIgnored private var selectionObserver: NSObjectProtocol?
    @ObservationIgnored private var textObserver: NSObjectProtocol?
    @ObservationIgnored private var keyMonitor: Any?
    @ObservationIgnored private var selectedSlashIndex = 0
    @ObservationIgnored private var dismissedSlashQuery: DismissedSlashQuery?

    private struct DismissedSlashQuery: Equatable {
        let markdown: String
        let range: NSRange
    }

    public init() {}

    deinit {
        if let selectionObserver { NotificationCenter.default.removeObserver(selectionObserver) }
        if let textObserver { NotificationCenter.default.removeObserver(textObserver) }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    func update(storage: RectoTextStorage, presentation: Presentation) {
        if self.storage !== storage { dismissedSlashQuery = nil }
        self.storage = storage
        self.presentation = presentation
        refreshState()
    }

    func attach(_ textView: RectoTextView?) {
        removeObservers()
        dismissedSlashQuery = nil
        self.textView = textView
        guard let nsTextView = textView?.nsTextView else {
            selectionState = RectoEditorSelectionState()
            slashMenuState = nil
            onStateChange?()
            return
        }

        selectionObserver = NotificationCenter.default.addObserver(
            forName: NSTextView.didChangeSelectionNotification,
            object: nsTextView,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.textView?.selectedRange != self.selectionState.range {
                    self.dismissedSlashQuery = nil
                }
                self.refreshState()
            }
        }
        textObserver = NotificationCenter.default.addObserver(
            forName: NSText.didChangeNotification,
            object: nsTextView,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.selectedSlashIndex = 0
                self?.dismissedSlashQuery = nil
                self?.refreshState()
            }
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            var result: NSEvent?
            MainActor.assumeIsolated { result = self?.handleKeyDown(event) ?? event }
            return result
        }
        refreshState()
    }

    /// Run a formatting command on the current selection.
    ///
    /// Works in every editable presentation: the transformer edits Markdown
    /// source, and the view's selection is in source coordinates whether the
    /// markers are hidden (rich) or shown (raw), because hiding is a font size,
    /// not a removal. Raw's "what you type is what the file gets" is about
    /// smart input, and an explicit command is not that. The slash menu and the
    /// selection bar are smart input, and stay rich-only.
    @discardableResult
    public func perform(_ command: RectoEditorCommand) -> Bool {
        guard presentation.isEditable,
              let storage,
              let textView,
              let edit = RectoCommandTransformer.edit(
                command: command,
                markdown: storage.markdown,
                selection: textView.selectedRange
              ) else { return false }
        return apply(edit, actionName: command.actionName)
    }

    /// Replace a source range as one structural edit (its own undo step),
    /// through the same path as the formatting commands, and put the caret at
    /// `selection`. For app features that write Markdown, like writing flags.
    @discardableResult
    public func replace(_ range: NSRange, with replacement: String, selection: NSRange, actionName: String) -> Bool {
        guard presentation.isEditable else { return false }
        return apply(
            RectoCommandEdit(patch: MarkdownTextPatch(range: range, replacement: replacement), selection: selection),
            actionName: actionName)
    }

    /// The source the editor holds, for callers that must check a range
    /// before replacing it.
    public var markdown: String? { storage?.markdown }

    public func moveSlashSelection(by delta: Int) {
        guard let state = slashMenuState, !state.entries.isEmpty else { return }
        selectedSlashIndex = (state.selectedIndex + delta + state.entries.count) % state.entries.count
        refreshState()
    }

    public func dismissSlashMenu() {
        if let state = slashMenuState, let storage {
            dismissedSlashQuery = DismissedSlashQuery(markdown: storage.markdown, range: state.queryRange)
        }
        slashMenuState = nil
        selectedSlashIndex = 0
        onStateChange?()
    }

    public func refreshSelectionGeometry() {
        refreshState()
    }

    @discardableResult
    public func selectSlashEntry(
        id: String? = nil,
        destination: String? = nil,
        alt: String = ""
    ) -> Bool {
        guard let state = slashMenuState else { return false }
        let entry = id.flatMap { requested in state.entries.first { $0.id == requested } }
            ?? state.selectedEntry
        guard let entry else { return false }
        let edit: RectoCommandEdit
        if entry.id == "link", let destination,
           let commandEdit = RectoCommandTransformer.edit(
            command: .link(destination: destination),
            markdown: "",
            selection: NSRange(location: 0, length: 0)
           ) {
            edit = replacingSlashQuery(commandEdit, range: state.queryRange)
        } else if entry.id == "image", let destination,
                  let commandEdit = RectoCommandTransformer.edit(
                    command: .image(source: destination, alt: alt),
                    markdown: "",
                    selection: NSRange(location: 0, length: 0)
                  ) {
            edit = replacingSlashQuery(commandEdit, range: state.queryRange)
        } else {
            edit = RectoSlashMenu.edit(entry: entry, queryRange: state.queryRange)
        }
        let applied = apply(edit, actionName: entry.label)
        if applied { dismissSlashMenu() }
        return applied
    }

    private func replacingSlashQuery(_ edit: RectoCommandEdit, range: NSRange) -> RectoCommandEdit {
        RectoCommandEdit(
            patch: MarkdownTextPatch(range: range, replacement: edit.patch.replacement),
            selection: NSRange(
                location: range.location + edit.selection.location,
                length: edit.selection.length
            ),
            generatedLineEndingRanges: edit.generatedLineEndingRanges
        )
    }

    private func apply(_ edit: RectoCommandEdit, actionName: String) -> Bool {
        guard let storage, let textView else { return false }
        let edit = normalized(edit, for: storage.lineEnding)
        let applied = storage.withStructuralEdit {
            textView.applyPatch(edit.patch, actionName: actionName)
        }
        guard applied else { return false }
        textView.selectedRange = edit.selection
        _ = textView.focus()
        refreshState()
        return true
    }

    private func normalized(_ edit: RectoCommandEdit, for lineEnding: MarkdownLineEnding) -> RectoCommandEdit {
        guard !edit.generatedLineEndingRanges.isEmpty else { return edit }
        let replacement = edit.patch.replacement as NSString
        let ranges = edit.generatedLineEndingRanges.sorted { $0.location < $1.location }
        var normalizedReplacement = ""
        var cursor = 0
        for range in ranges {
            guard range.location >= cursor, NSMaxRange(range) <= replacement.length else { return edit }
            normalizedReplacement += replacement.substring(with: NSRange(
                location: cursor,
                length: range.location - cursor
            ))
            normalizedReplacement += lineEnding.normalize(replacement.substring(with: range))
            cursor = NSMaxRange(range)
        }
        normalizedReplacement += replacement.substring(from: cursor)
        guard normalizedReplacement != edit.patch.replacement else { return edit }

        func map(_ position: Int) -> Int {
            let relative = position - edit.patch.range.location
            if relative < 0 { return position }
            guard relative <= replacement.length else {
                return position + (normalizedReplacement as NSString).length - replacement.length
            }
            var mapped = relative
            for range in ranges {
                if relative <= range.location { break }
                let prefixLength = min(relative, NSMaxRange(range)) - range.location
                let prefix = replacement.substring(with: NSRange(location: range.location, length: prefixLength))
                mapped += (lineEnding.normalize(prefix) as NSString).length - prefixLength
                if relative <= NSMaxRange(range) { break }
            }
            return edit.patch.range.location + mapped
        }

        let start = map(edit.selection.location)
        let end = map(NSMaxRange(edit.selection))
        return RectoCommandEdit(
            patch: MarkdownTextPatch(range: edit.patch.range, replacement: normalizedReplacement),
            selection: NSRange(location: start, length: max(0, end - start)),
            generatedLineEndingRanges: []
        )
    }

    private func handleKeyDown(_ event: NSEvent) -> NSEvent? {
        guard let state = slashMenuState,
              let nsTextView = textView?.nsTextView,
              event.window === nsTextView.window,
              nsTextView.window?.firstResponder === nsTextView else { return event }
        switch event.keyCode {
        case 125:
            moveSlashSelection(by: 1)
            return nil
        case 126:
            moveSlashSelection(by: -1)
            return nil
        case 36, 48, 76:
            if let entry = state.selectedEntry, let onActivateSlashEntry {
                onActivateSlashEntry(entry)
            } else {
                _ = selectSlashEntry()
            }
            return nil
        case 53:
            dismissSlashMenu()
            return nil
        default:
            return event
        }
    }

    private func refreshState() {
        guard let storage, let textView, let nsTextView = textView.nsTextView else { return }
        let range = textView.selectedRange
        let source = storage.markdown as NSString
        let selectedText = NSMaxRange(range) <= source.length ? source.substring(with: range) : ""
        let rects = textView.rects(forSourceRange: range)
        selectionState = RectoEditorSelectionState(
            range: range,
            selectedText: selectedText,
            activeInlineCommands: RectoCommandTransformer.activeInlineCommands(
                markdown: storage.markdown,
                selection: range
            ),
            anchorRect: rects.reduce(nil) { partial, rect in
                partial.map { $0.union(rect) } ?? rect
            },
            isEditable: presentation == .rich && nsTextView.isEditable
        )
        let slashState = presentation == .rich && nsTextView.isEditable
            ? RectoSlashMenu.state(
                markdown: storage.markdown,
                selection: range,
                selectedIndex: selectedSlashIndex,
                anchorRect: textView.caretRect()
              )
            : nil
        slashMenuState = if let slashState,
                            dismissedSlashQuery != DismissedSlashQuery(
                                markdown: storage.markdown,
                                range: slashState.queryRange
                            ) {
            slashState
        } else {
            nil
        }
        onStateChange?()
    }

    private func removeObservers() {
        if let selectionObserver { NotificationCenter.default.removeObserver(selectionObserver) }
        if let textObserver { NotificationCenter.default.removeObserver(textObserver) }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        selectionObserver = nil
        textObserver = nil
        keyMonitor = nil
    }
}
