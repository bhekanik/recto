#if canImport(AppKit)
import AppKit
import Foundation

@testable import RectoVim

/// A text view in a window, wired to an engine over the built bundle.
///
/// The window is not decoration: `NSTextView.undoManager` comes from the
/// responder chain, so a view with no window has **no undo manager at all** and
/// `u` silently does nothing. `allowsUndo` matters for the same reason — without
/// it `shouldChangeText` registers nothing.
///
/// `press` drives keys the way `keyDown` does, and that is the point: whatever
/// vim declines goes to the text view's input system, which turns it into
/// `insertText:` and back through the adapter. Synthesising the insert instead
/// would leave the whole external-input path untested.
@MainActor
final class TextViewHarness {
    let window: NSWindow
    let textView: BlockCaretTextView
    let engine: VimEngine
    let adapter: VimTextViewAdapter
    var failures: [VimReplayFailure] = []
    private var clipboard = ""

    init(_ text: String, width: CGFloat = 600) throws {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        textView = BlockCaretTextView(frame: window.contentLayoutRect)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.string = text
        window.contentView?.addSubview(textView)
        window.makeFirstResponder(textView)

        let host = VimHost()
        engine = try VimEngine(bundleURL: Fixtures.bundleURL, host: host)
        adapter = VimTextViewAdapter(textView: textView, engine: engine, host: host)
        host.pasteboardRead = { [unowned self] in clipboard }
        host.pasteboardWrite = { [unowned self] in clipboard = $0 }
        try adapter.start()
        adapter.onReplayFailure = { [unowned self] in failures.append($0) }
    }

    /// Drives a key the way `keyDown` does: vim first, and whatever it
    /// declines goes to the text view's input system.
    /// Place the caret where a fixture starts, then drive its keys.
    func run(_ testCase: KeystrokeSuite.Case) throws {
        try adapter.setCursor(line: testCase.cursor[0], column: testCase.cursor[1])
        press(testCase.keys)
    }

    func press(_ spec: String) {
        for key in VimKeys.parse(spec) {
            if adapter.handle(key: key.key, modifiers: key.modifiers) { continue }
            guard key.key.count == 1, !key.modifiers.contains(.control),
                !key.modifiers.contains(.command)
            else { continue }
            textView.insertText(
                key.key, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
    }
}
#endif
