import AppKit
import RectoEditor
import SwiftUI

struct WritingControlsHost: NSViewRepresentable {
    let controller: RectoWritingController

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.install()
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.refresh()
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.uninstall()
    }

    @MainActor
    final class Coordinator {
        private static let selectionPanelSize = NSSize(width: 246, height: 38)

        private weak var controller: RectoWritingController?
        private let slashPopover = NSPopover()
        private let inputPopover = NSPopover()
        private var selectionPanel: NSPanel?
        private weak var observedTextView: NSTextView?
        private weak var observedWindow: NSWindow?
        private weak var observedScrollView: NSScrollView?
        private weak var observedClipView: NSClipView?
        private var windowObservers: [NSObjectProtocol] = []
        private var clipObserver: NSObjectProtocol?
        private var clipViewOriginallyPostedBoundsChanges = false
        private var applicationIsActive = true
        private var ownerWindowIsKey = false

        var isSelectionPanelVisible: Bool { selectionPanel?.isVisible == true }
        var selectionPanelFrame: NSRect? { selectionPanel?.frame }
        var isInputPopoverShown: Bool { inputPopover.isShown }

        init(controller: RectoWritingController) {
            self.controller = controller
            slashPopover.behavior = .semitransient
            inputPopover.behavior = .applicationDefined
        }

        func install() {
            controller?.onStateChange = { [weak self] in self?.refresh() }
            controller?.onActivateSlashEntry = { [weak self] entry in self?.selectSlash(entry) }
            refresh()
        }

        func uninstall() {
            controller?.onStateChange = nil
            controller?.onActivateSlashEntry = nil
            removeLifecycleObservers()
            hideChrome()
            selectionPanel = nil
        }

        func refresh() {
            guard let controller else { return }
            let textView = controllerTextView
            observe(textView)
            guard applicationIsActive else {
                hideChrome()
                return
            }
            guard ownerWindowIsKey || inputPopoverWindowIsKey else {
                hideChrome()
                return
            }
            guard ownerWindowIsKey else {
                hideChrome(preservingInput: true)
                return
            }
            updateSlashPopover(controller)
            updateSelectionPanel(controller)
        }

        private func observe(_ textView: NSTextView?) {
            let window = textView?.window
            let scrollView = textView?.enclosingScrollView
            let clipView = scrollView?.contentView
            if observedTextView === textView,
               observedWindow === window,
               observedScrollView === scrollView {
                guard observedClipView !== clipView else { return }
                replaceClipObservation(with: clipView)
                return
            }
            removeLifecycleObservers()
            observedTextView = textView
            observedWindow = window
            observedScrollView = scrollView
            ownerWindowIsKey = window?.isKeyWindow == true
            let center = NotificationCenter.default
            if let window {
                windowObservers = [
                    center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] _ in
                        MainActor.assumeIsolated {
                            guard let self,
                                  self.controllerTextView?.window?.isKeyWindow == true else { return }
                            self.refresh()
                        }
                    },
                    center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self, weak window] _ in
                        MainActor.assumeIsolated {
                            guard let self, self.observedWindow === window else { return }
                            self.ownerWindowIsKey = true
                            self.refresh()
                        }
                    },
                    center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self, weak window] _ in
                        MainActor.assumeIsolated {
                            guard let self, let window, self.observedWindow === window else { return }
                            self.ownerWindowIsKey = false
                            self.ownerWindowDidResignKey(window)
                        }
                    },
                    center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self, weak window] _ in
                        MainActor.assumeIsolated {
                            guard let self, self.observedWindow === window else { return }
                            self.ownerWindowIsKey = false
                            self.hideChrome()
                        }
                    },
                    center.addObserver(forName: NSWindow.didMoveNotification, object: window, queue: .main) { [weak self, weak window] _ in
                        MainActor.assumeIsolated {
                            guard let self, let window else { return }
                            self.scheduleGeometryRefresh(for: window, recomputingSelection: false)
                        }
                    },
                    center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self, weak window] _ in
                        MainActor.assumeIsolated {
                            guard let self, let window else { return }
                            self.scheduleGeometryRefresh(for: window, recomputingSelection: true)
                        }
                    },
                ]
            }
            windowObservers.append(center.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.applicationIsActive = false
                    self.hideChrome()
                }
            })
            windowObservers.append(center.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.applicationIsActive = true
                    self.refresh()
                }
            })
            windowObservers.append(center.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self,
                          self.observedClipView !== self.controllerTextView?.enclosingScrollView?.contentView else {
                        return
                    }
                    self.refresh()
                }
            })
            if let scrollView {
                for name in [
                    NSScrollView.willStartLiveScrollNotification,
                    NSScrollView.didLiveScrollNotification,
                    NSScrollView.didEndLiveScrollNotification,
                ] {
                    windowObservers.append(center.addObserver(
                        forName: name,
                        object: scrollView,
                        queue: .main
                    ) { [weak self, weak scrollView] _ in
                        MainActor.assumeIsolated {
                            guard let self, let scrollView, self.observedScrollView === scrollView else { return }
                            self.controller?.refreshSelectionGeometry()
                        }
                    })
                }
            }
            replaceClipObservation(with: clipView)
        }

        private func replaceClipObservation(with clipView: NSClipView?) {
            removeClipObservation()
            observedClipView = clipView
            guard let clipView else { return }
            clipViewOriginallyPostedBoundsChanges = clipView.postsBoundsChangedNotifications
            clipView.postsBoundsChangedNotifications = true
            clipObserver = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: clipView,
                queue: .main
            ) { [weak self, weak clipView] _ in
                MainActor.assumeIsolated {
                    guard let self, let clipView else { return }
                    self.scheduleGeometryRefresh(for: clipView)
                }
            }
        }

        private func removeClipObservation() {
            if let clipObserver { NotificationCenter.default.removeObserver(clipObserver) }
            clipObserver = nil
            if let observedClipView {
                observedClipView.postsBoundsChangedNotifications = clipViewOriginallyPostedBoundsChanges
            }
            observedClipView = nil
            clipViewOriginallyPostedBoundsChanges = false
        }

        private func removeLifecycleObservers() {
            for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
            windowObservers.removeAll()
            removeClipObservation()
            observedTextView = nil
            observedWindow = nil
            observedScrollView = nil
            ownerWindowIsKey = false
        }

        private var inputPopoverWindowIsKey: Bool {
            inputPopover.contentViewController?.view.window?.isKeyWindow == true
        }

        private func scheduleGeometryRefresh(for window: NSWindow, recomputingSelection: Bool) {
            guard observedWindow === window else { return }
            window.contentView?.layoutSubtreeIfNeeded()
            if recomputingSelection {
                controller?.refreshSelectionGeometry()
            } else {
                refresh()
            }
        }

        private func scheduleGeometryRefresh(for clipView: NSClipView) {
            guard observedClipView === clipView else { return }
            controller?.refreshSelectionGeometry()
        }

        private func ownerWindowDidResignKey(_ window: NSWindow) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.observedWindow === window else { return }
                if self.inputPopover.isShown {
                    self.hideChrome(preservingInput: true)
                } else {
                    self.hideChrome()
                }
            }
        }

        private func hideChrome(preservingInput: Bool = false) {
            slashPopover.close()
            if !preservingInput { inputPopover.close() }
            selectionPanel?.orderOut(nil)
        }

        func showSelectionLinkInput() {
            showDestinationInput(kind: .selectionLink)
        }

        private func updateSlashPopover(_ controller: RectoWritingController) {
            guard let state = controller.slashMenuState,
                  !state.entries.isEmpty,
                  let textView = controllerTextView else {
                slashPopover.close()
                return
            }
            slashPopover.contentViewController = NSHostingController(rootView: SlashMenuView(
                state: state,
                onSelect: { [weak self] entry in self?.selectSlash(entry) }
            ))
            slashPopover.contentSize = NSSize(width: 280, height: min(360, 38 + state.entries.count * 30))
            if !slashPopover.isShown {
                slashPopover.show(
                    relativeTo: state.anchorRect ?? textView.bounds,
                    of: textView,
                    preferredEdge: .maxY
                )
            }
        }

        private func updateSelectionPanel(_ controller: RectoWritingController) {
            let state = controller.selectionState
            guard state.canFormatSelection,
                  let anchor = state.anchorRect,
                  let textView = controllerTextView,
                  let window = textView.window else {
                selectionPanel?.orderOut(nil)
                return
            }
            let visibleAnchor = anchor.intersection(textView.visibleRect)
            guard !visibleAnchor.isNull, !visibleAnchor.isEmpty else {
                selectionPanel?.orderOut(nil)
                return
            }

            let panel = selectionPanel ?? makeSelectionPanel()
            let contentView = NSHostingView(rootView: SelectionFormatBar(
                active: state.activeInlineCommands,
                onCommand: { [weak self] command in
                    guard let self else { return }
                    if case .link = command {
                        self.showDestinationInput(kind: .selectionLink)
                    } else {
                        _ = self.controller?.perform(command)
                    }
                }
            ))
            panel.contentView = contentView
            contentView.layoutSubtreeIfNeeded()
            panel.setContentSize(contentView.fittingSize)
            let windowRect = textView.convert(visibleAnchor, to: nil)
            let screenRect = window.convertToScreen(windowRect)
            let size = panel.frame.size
            let screen = NSScreen.screens.first {
                $0.frame.contains(NSPoint(x: screenRect.midX, y: screenRect.midY))
            } ?? window.screen
            let visibleFrame = screen?.visibleFrame ?? screenRect
            let above = screenRect.maxY + 8
            let below = screenRect.minY - size.height - 8
            let preferredY = above + size.height <= visibleFrame.maxY ? above : below
            panel.setFrameOrigin(NSPoint(
                x: min(max(screenRect.midX - size.width / 2, visibleFrame.minX), visibleFrame.maxX - size.width),
                y: min(max(preferredY, visibleFrame.minY), visibleFrame.maxY - size.height)
            ))
            panel.orderFront(nil)
        }

        private var controllerTextView: NSTextView? {
            controller?.attachedTextView
        }

        private func makeSelectionPanel() -> NSPanel {
            let panel = NSPanel(
                contentRect: NSRect(origin: .zero, size: Self.selectionPanelSize),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.isFloatingPanel = true
            panel.level = .floating
            panel.hasShadow = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            selectionPanel = panel
            return panel
        }

        private func selectSlash(_ entry: RectoSlashEntry) {
            switch entry.id {
            case "link": showDestinationInput(kind: .slashLink)
            case "image": showDestinationInput(kind: .slashImage)
            default: _ = controller?.selectSlashEntry(id: entry.id)
            }
        }

        private func showDestinationInput(kind: DestinationKind) {
            guard let textView = controllerTextView else { return }
            let title = kind == .slashImage ? "Add image" : "Add link"
            inputPopover.contentViewController = NSHostingController(rootView: DestinationInputView(
                title: title,
                asksForAltText: kind == .slashImage,
                onCancel: { [weak inputPopover] in inputPopover?.close() },
                onSubmit: { [weak self] destination, alt in
                    guard let self else { return }
                    switch kind {
                    case .selectionLink:
                        _ = self.controller?.perform(.link(destination: destination))
                    case .slashLink:
                        _ = self.controller?.selectSlashEntry(id: "link", destination: destination)
                    case .slashImage:
                        _ = self.controller?.selectSlashEntry(
                            id: "image",
                            destination: destination,
                            alt: alt
                        )
                    }
                    self.inputPopover.close()
                }
            ))
            inputPopover.contentSize = NSSize(width: 320, height: kind == .slashImage ? 132 : 96)
            let anchor = controller?.selectionState.anchorRect
                ?? controller?.slashMenuState?.anchorRect
                ?? textView.bounds
            inputPopover.show(relativeTo: anchor, of: textView, preferredEdge: .maxY)
        }

        private enum DestinationKind { case selectionLink, slashLink, slashImage }
    }
}

private struct SlashMenuView: View {
    let state: RectoSlashMenuState
    let onSelect: (RectoSlashEntry) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(Array(state.entries.enumerated()), id: \.element.id) { index, entry in
                    Button {
                        onSelect(entry)
                    } label: {
                        HStack {
                            Text(entry.label)
                            Spacer()
                            if index == state.selectedIndex {
                                Image(systemName: "return")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .frame(height: 28)
                        .background(index == state.selectedIndex ? Color.accentColor.opacity(0.16) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(index == state.selectedIndex ? .isSelected : [])
                }
            }
            .padding(6)
        }
        .accessibilityLabel("Insert block")
    }
}

private struct SelectionFormatBar: View {
    let active: Set<RectoEditorCommand>
    let onCommand: (RectoEditorCommand) -> Void

    var body: some View {
        HStack(spacing: 2) {
            commandButton(.bold, symbol: "bold", label: "Bold")
            commandButton(.italic, symbol: "italic", label: "Italic")
            commandButton(.strikethrough, symbol: "strikethrough", label: "Strikethrough")
            commandButton(.inlineCode, symbol: "chevron.left.forwardslash.chevron.right", label: "Inline code")
            commandButton(.link(destination: ""), symbol: "link", label: "Link")
        }
        .padding(4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
    }

    private func commandButton(_ command: RectoEditorCommand, symbol: String, label: String) -> some View {
        Button { onCommand(command) } label: {
            Image(systemName: symbol)
                .frame(width: 28, height: 28)
                .background(active.contains(command) ? Color.accentColor.opacity(0.22) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }
}

private struct DestinationInputView: View {
    let title: String
    let asksForAltText: Bool
    let onCancel: () -> Void
    let onSubmit: (String, String) -> Void
    @State private var destination = ""
    @State private var alt = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            TextField("URL or path", text: $destination)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
            if asksForAltText {
                TextField("Alt text", text: $alt)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submit)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Insert", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
    }

    private func submit() {
        let value = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        onSubmit(value, alt)
    }
}
