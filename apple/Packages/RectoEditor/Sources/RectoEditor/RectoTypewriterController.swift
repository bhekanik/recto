//
//  RectoTypewriterController.swift
//  RectoEditor
//

import AppKit

/// Keeps the active caret line at the center of its editor viewport.
///
/// Give ``attach(to:)`` directly to `RectoEditorView.onAttach`. The controller
/// installs observers only while enabled and attached, and removes them when
/// either condition ends.
///
/// History and sync apply text programmatically. Wrap those synchronous editor
/// mutations in ``performProgrammaticChange(_:)`` so intermediate selection
/// notifications do not scroll; one center pass runs after the mutation.
@MainActor
public final class RectoTypewriterController {
    public var isEnabled: Bool {
        didSet {
            guard isEnabled != oldValue else { return }
            refreshActivation()
        }
    }

    private var seam: RectoTextView?
    private weak var textView: NSTextView?
    private weak var scrollView: NSScrollView?
    private var originalTextContainerInset: NSSize?
    private var originalPostsFrameChangedNotifications = false
    private var observationTokens: [NSObjectProtocol] = []
    private var eventMonitor: Any?
    private var recenterGeneration = 0
    private var isRecenterScheduled = false
    private var suspensionDepth = 0
    private var isDraggingSelection = false
    private var needsRecenter = false

    public init(isEnabled: Bool = false) {
        self.isEnabled = isEnabled
    }

    deinit {
        for token in observationTokens {
            NotificationCenter.default.removeObserver(token)
        }
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
        }
    }

    /// Attach the current editor seam, or detach with `nil`.
    public func attach(to seam: RectoTextView?) {
        let incomingTextView = seam?.nsTextView
        if incomingTextView === textView {
            self.seam = seam
            return
        }

        deactivate(restoreInset: true)
        self.seam = seam
        textView = incomingTextView
        scrollView = seam?.scrollView
        originalTextContainerInset = incomingTextView?.textContainerInset
        refreshActivation()
    }

    /// Suppress intermediate scrolls during one synchronous history or sync
    /// application, then center once after it completes.
    @discardableResult
    public func performProgrammaticChange<Result>(
        _ operation: () throws -> Result
    ) rethrows -> Result {
        suspensionDepth += 1
        defer {
            suspensionDepth -= 1
            if suspensionDepth == 0 {
                needsRecenter = true
                scheduleRecenter()
            }
        }
        return try operation()
    }

    private func refreshActivation() {
        guard isEnabled, textView != nil, scrollView != nil else {
            deactivate(restoreInset: true)
            return
        }
        guard observationTokens.isEmpty, eventMonitor == nil else { return }

        updateTextContainerInset()
        installObservers()
        installSelectionDragMonitor()
        needsRecenter = true
        scheduleRecenter()
    }

    private func deactivate(restoreInset: Bool) {
        recenterGeneration += 1
        isRecenterScheduled = false
        for token in observationTokens {
            NotificationCenter.default.removeObserver(token)
        }
        observationTokens.removeAll()
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
            self.eventMonitor = nil
        }
        if restoreInset, let textView, let originalTextContainerInset {
            textView.textContainerInset = originalTextContainerInset
        }
        if let clipView = scrollView?.contentView {
            clipView.postsFrameChangedNotifications = originalPostsFrameChangedNotifications
        }
        isDraggingSelection = false
        needsRecenter = false
    }

    private func installObservers() {
        guard let textView, let clipView = scrollView?.contentView else { return }
        let center = NotificationCenter.default
        observationTokens.append(center.addObserver(
            forName: NSTextView.didChangeSelectionNotification,
            object: textView,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.selectionOrTextDidChange() }
        })
        observationTokens.append(center.addObserver(
            forName: NSText.didChangeNotification,
            object: textView,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.selectionOrTextDidChange() }
        })

        originalPostsFrameChangedNotifications = clipView.postsFrameChangedNotifications
        clipView.postsFrameChangedNotifications = true
        observationTokens.append(center.addObserver(
            forName: NSView.frameDidChangeNotification,
            object: clipView,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.updateTextContainerInset()
                self?.needsRecenter = true
                self?.scheduleRecenter()
            }
        })
    }

    private func installSelectionDragMonitor() {
        eventMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            MainActor.assumeIsolated { self?.handlePointerEvent(event) }
            return event
        }
    }

    private func handlePointerEvent(_ event: NSEvent) {
        guard let textView else { return }
        switch event.type {
        case .leftMouseDown:
            guard event.window === textView.window else { return }
            let point = textView.convert(event.locationInWindow, from: nil)
            guard textView.bounds.contains(point) else { return }
            isDraggingSelection = true
        case .leftMouseUp:
            guard isDraggingSelection else { return }
            isDraggingSelection = false
            needsRecenter = true
            scheduleRecenter()
        default:
            break
        }
    }

    private func selectionOrTextDidChange() {
        needsRecenter = true
        scheduleRecenter()
    }

    private func scheduleRecenter() {
        guard !isRecenterScheduled, isEnabled, seam != nil else { return }
        isRecenterScheduled = true
        let generation = recenterGeneration
        RunLoop.main.perform(inModes: [.common]) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.recenterGeneration == generation else { return }
                self.isRecenterScheduled = false
                self.recenterIfPossible()
            }
        }
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }

    private func recenterIfPossible() {
        guard needsRecenter, isEnabled,
              suspensionDepth == 0, !isDraggingSelection,
              let seam, let textView,
              textView.window?.firstResponder === textView,
              textView.selectedRange().length == 0,
              !textView.hasMarkedText()
        else { return }

        needsRecenter = false
        _ = seam.scroll(range: textView.selectedRange(), position: .center)
    }

    private func updateTextContainerInset() {
        guard isEnabled, let textView, let scrollView,
              let originalTextContainerInset else { return }
        let visibleHeight = max(
            0,
            scrollView.contentView.bounds.height
                - scrollView.contentInsets.top
                - scrollView.contentInsets.bottom
        )
        let font = textView.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let lineHeight = font.ascender - font.descender + font.leading
        let vertical = max(originalTextContainerInset.height, (visibleHeight - lineHeight) / 2)
        let inset = NSSize(width: originalTextContainerInset.width, height: vertical)
        guard inset != textView.textContainerInset else { return }
        textView.textContainerInset = inset
    }
}
