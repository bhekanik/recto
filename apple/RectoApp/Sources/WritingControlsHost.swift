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
        private weak var controller: RectoWritingController?
        private let slashPopover = NSPopover()
        private let inputPopover = NSPopover()
        private var selectionPanel: NSPanel?
        private weak var observedWindow: NSWindow?
        private var windowObservers: [NSObjectProtocol] = []
        private var ownerWindowIsKey = false

        var isSelectionPanelVisible: Bool { selectionPanel?.isVisible == true }
        var isInputPopoverShown: Bool { inputPopover.isShown }

        init(controller: RectoWritingController) {
            self.controller = controller
            slashPopover.behavior = .semitransient
            inputPopover.behavior = .transient
        }

        func install() {
            controller?.onStateChange = { [weak self] in self?.refresh() }
            controller?.onActivateSlashEntry = { [weak self] entry in self?.selectSlash(entry) }
            refresh()
        }

        func uninstall() {
            controller?.onStateChange = nil
            controller?.onActivateSlashEntry = nil
            removeWindowObservers()
            hideChrome()
            selectionPanel = nil
        }

        func refresh() {
            guard let controller else { return }
            let window = controllerTextView?.window
            observe(window)
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

        private func observe(_ window: NSWindow?) {
            guard observedWindow !== window else { return }
            removeWindowObservers()
            observedWindow = window
            ownerWindowIsKey = window?.isKeyWindow == true
            guard let window else { return }
            let center = NotificationCenter.default
            windowObservers = [
                center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.ownerWindowIsKey = true
                        self?.refresh()
                    }
                },
                center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.ownerWindowIsKey = false
                        self?.ownerWindowDidResignKey()
                    }
                },
                center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.ownerWindowIsKey = false
                        self?.hideChrome()
                    }
                },
            ]
        }

        private func removeWindowObservers() {
            for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
            windowObservers.removeAll()
            observedWindow = nil
            ownerWindowIsKey = false
        }

        private var inputPopoverWindowIsKey: Bool {
            inputPopover.contentViewController?.view.window?.isKeyWindow == true
        }

        private func ownerWindowDidResignKey() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.inputPopoverWindowIsKey {
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

            let panel = selectionPanel ?? makeSelectionPanel()
            panel.contentView = NSHostingView(rootView: SelectionFormatBar(
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
            let windowRect = textView.convert(anchor, to: nil)
            let screenRect = window.convertToScreen(windowRect)
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(
                x: screenRect.midX - size.width / 2,
                y: screenRect.maxY + 8
            ))
            panel.orderFront(nil)
        }

        private var controllerTextView: NSTextView? {
            controller?.attachedTextView
        }

        private func makeSelectionPanel() -> NSPanel {
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 246, height: 38),
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
