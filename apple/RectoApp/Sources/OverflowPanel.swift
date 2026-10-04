import AppKit
import RectoEditor
import SwiftUI

struct OverflowPanel: View {
    let model: OverflowModel
    let theme: RectoEditorTheme
    let close: () -> Void
    let onFocus: () -> Void
    @State private var showsOtherCopy = false
    @State private var resolution: Bool?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Overflow").font(.system(size: 13, weight: .medium))
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).focusable(false)
                    .help("Close Overflow").accessibilityLabel("Close Overflow")
            }
            .foregroundStyle(Color(nsColor: theme.ink2))
            .padding(.horizontal, 12).frame(height: 36)
            Color(nsColor: theme.line).frame(height: 1)
            Text("Notes stay outside your draft and exports. Copy any passage back when you need it.")
                .font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink3))
                .padding(12)
            OverflowEditor(model: model, theme: theme, onFocus: onFocus)
            if model.unsavedMarkdown != nil {
                Button("Retry saving notes", action: model.retryUnsaved).padding(12)
                Text("These changes are not saved. Keep this panel open or copy them before closing.")
                    .font(.system(size: 12)).padding(.horizontal, 12)
            }
            if let other = model.record.remoteMarkdown {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Overflow changed on another device. Both copies are saved on this Mac.")
                    Button(showsOtherCopy ? "Hide other copy" : "View other copy") { showsOtherCopy.toggle() }
                    if showsOtherCopy {
                        ScrollView { Text(verbatim: other).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            .frame(maxHeight: 160)
                    }
                    HStack {
                        Button("Keep this copy") { resolution = true }
                        Button("Use other copy") { resolution = false }
                    }
                }.font(.system(size: 12)).padding(12)
                    .disabled(model.unsavedMarkdown != nil)
            }
            Text(model.errorMessage ?? model.record.syncError ?? (model.record.isDirty ? "Saved on this Mac · waiting to sync" : "Saved"))
                .font(.system(size: 11)).foregroundStyle(Color(nsColor: theme.ink3))
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 320)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
        .confirmationDialog("Replace the other Overflow copy?", isPresented: Binding(get: { resolution != nil }, set: { if !$0 { resolution = nil } })) {
            if let keepLocal = resolution {
                Button(keepLocal ? "Replace other copy with this copy" : "Replace this copy with other copy", role: .destructive) {
                    model.resolve(keepLocal: keepLocal)
                    resolution = nil
                }
            }
            Button("Cancel", role: .cancel) { resolution = nil }
        } message: {
            Text("Copy any notes you want to keep before replacing a copy.")
        }
    }
}

/// A separate responder and undo manager keep scratchpad edits out of prose history.
final class OverflowTextView: NSTextView {
    private let history = UndoManager()
    private var historyObservers: [NSObjectProtocol] = []

    // Menu and toolbar actions invoke the manager directly; AppKit omits the delegate update.
    func observeHistory() {
        for name in [Notification.Name.NSUndoManagerDidUndoChange, Notification.Name.NSUndoManagerDidRedoChange] {
            historyObservers.append(NotificationCenter.default.addObserver(forName: name, object: history, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.didChangeText() }
            })
        }
    }

    isolated deinit {
        for observer in historyObservers { NotificationCenter.default.removeObserver(observer) }
    }
    var onFocus: () -> Void = {}
    override func becomeFirstResponder() -> Bool {
        let focused = super.becomeFirstResponder()
        if focused { onFocus() }
        return focused
    }
    override var undoManager: UndoManager? { history }
}

private struct OverflowEditor: NSViewRepresentable {
    let model: OverflowModel
    let theme: RectoEditorTheme

    let onFocus: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        let text = OverflowTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 300))
        text.observeHistory()
        text.onFocus = onFocus
        text.isRichText = false
        text.allowsUndo = true
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.textContainerInset = NSSize(width: 12, height: 12)
        text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        text.setAccessibilityLabel("Overflow notes")
        text.string = model.displayMarkdown
        text.delegate = context.coordinator
        scroll.documentView = text
        context.coordinator.generation = model.record.generation
        applyTheme(text, scroll)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let text = scroll.documentView as? OverflowTextView else { return }
        applyTheme(text, scroll)
        context.coordinator.generation = model.record.generation
        if !(text.string as NSString).isEqual(to: model.displayMarkdown) {
            // A remote copy or another pane replaced the buffer. Old undo cannot overwrite it.
            text.string = model.displayMarkdown
            text.undoManager?.removeAllActions()
        }
    }
    private func applyTheme(_ text: NSTextView, _ scroll: NSScrollView) {
        scroll.backgroundColor = theme.sheet
        text.backgroundColor = theme.sheet
        text.textColor = theme.ink
        text.insertionPointColor = theme.ink
    }
    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        let model: OverflowModel
        var generation = 0
        init(model: OverflowModel) { self.model = model }
        func textDidChange(_ notification: Notification) {
            guard let text = notification.object as? NSTextView else { return }
            if model.accept(text.string, expectedGeneration: generation) { generation = model.record.generation }
        }
    }
}
