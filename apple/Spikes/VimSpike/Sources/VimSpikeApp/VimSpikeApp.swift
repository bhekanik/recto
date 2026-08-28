import AppKit
import RectoVim
import SwiftUI

/// The visible half of the N0c spike: the vim engine driving a real
/// `NSTextView`, with the caret shape and status bar the design plan asks for.
///
/// Everything interesting is in `RectoVim`; this target exists so the behaviour
/// can be watched rather than only asserted.
@main
struct VimSpikeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup("RectoVim spike") {
            EditorScreen()
                .frame(minWidth: 720, minHeight: 480)
        }
        .windowStyle(.titleBar)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Run from the terminal there is no bundle to make us a foreground app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

struct EditorScreen: View {
    @State private var status = StatusModel()

    var body: some View {
        VStack(spacing: 0) {
            VimTextEditor(status: $status)
            statusBar
        }
    }

    /// Vim's status line: mode on the left, the `:`/`/` line in the middle,
    /// pending keys on the right — the same slots as the design plan's §4.3.
    private var statusBar: some View {
        HStack(spacing: 12) {
            Text(status.label.isEmpty ? "Vim · normal" : status.label)
                .foregroundStyle(status.label.isEmpty ? .secondary : .primary)
                .fontWeight(status.label.isEmpty ? .regular : .semibold)
            if let prompt = status.prompt {
                Text(prompt).foregroundStyle(.primary)
            } else if let message = status.message {
                Text(message).foregroundStyle(.secondary)
            }
            Spacer()
            Text(status.pending).foregroundStyle(.secondary)
        }
        .font(.system(.caption, design: .monospaced))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
    }
}

struct StatusModel: Equatable {
    var label = ""
    var pending = ""
    var prompt: String?
    var message: String?
}

/// Hosts the `NSTextView` and owns the engine for its lifetime.
struct VimTextEditor: NSViewRepresentable {
    @Binding var status: StatusModel

    func makeCoordinator() -> Coordinator { Coordinator(status: $status) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        // `scrollableTextView()` gives a TextKit 2 stack on macOS 26; nothing
        // here may touch `layoutManager` or it silently falls back to TextKit 1.
        guard let existing = scrollView.documentView as? NSTextView else { return scrollView }

        let textView = BlockCaretTextView(frame: existing.frame)
        textView.autoresizingMask = existing.autoresizingMask
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 12, height: 12)
        textView.string = Self.sampleDocument
        scrollView.documentView = textView

        context.coordinator.attach(to: textView)
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {}

    static let sampleDocument = """
        # RectoVim spike

        Try it: `dw`, `ciw`, `3dd`, `v` then a motion then `d`, `/spike` then
        `n` and `N`, a `.` repeat, `u` and Ctrl-R, and `:s/spike/probe/`.

        The quick brown fox jumps over the lazy dog. Pack my box with five
        dozen liquor jugs. How vexingly quick daft zebras jump.

        Emoji live here too: 🎩 sits between these words, and a family
        👨‍👩‍👧‍👦 is a single grapheme spanning several UTF-16 units.
        """

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding private var status: StatusModel
        private var controller: VimTextViewController?

        init(status: Binding<StatusModel>) {
            _status = status
        }

        func attach(to textView: BlockCaretTextView) {
            do {
                let host = RectoVimHost()
                let engine = try RectoVimEngine(
                    bundleURL: RectoVimEngine.bundledScriptURL(), host: host
                )
                let controller = VimTextViewController(
                    textView: textView, engine: engine, host: host
                )
                controller.onStatusChange = { [weak self] status in
                    self?.status = StatusModel(
                        label: status.label,
                        pending: status.pending,
                        prompt: status.prompt,
                        message: status.message
                    )
                }
                textView.keyHook = { [weak controller] event in
                    controller?.handle(event) ?? false
                }
                try controller.start()
                self.controller = controller
            } catch {
                NSLog("RectoVim spike failed to start: %@", String(describing: error))
            }
        }
    }
}
